type JsonRecord = Record<string, unknown>;
type AccessRole = "site" | "admin";
type EventType = "start" | "refresh" | "ticket_activity_end" | "daily_end";

interface Env {
	DB: D1Database;
	OPERA_SITE_TOKEN: string;
	OPERA_ADMIN_TOKEN: string;
}

interface OperaEvent {
	schema_version: string;
	opera_version: string;
	event_id: string;
	tipo_evento: EventType;
	gerado_em: string;
	origem?: JsonRecord;
	dados: JsonRecord;
	transmissao?: JsonRecord;
	integridade: JsonRecord;
}

interface ValidationResult {
	ok: boolean;
	errors: string[];
}

interface TicketInput {
	code: string;
	title: string | null;
	summary: string | null;
	formalStatus: string | null;
	classification: string | null;
	active: number;
	openedAt: string | null;
	dueAt: string | null;
	closedAt: string | null;
	originalRequest: string | null;
	relevantEvolution: string | null;
	relevantDecisionsJson: string | null;
	lastRealAdvance: string | null;
	currentSituation: string | null;
	dependenciesJson: string | null;
	pendingItemsJson: string | null;
	nextStep: string | null;
	naturalSummary: string | null;
	complexity: string | null;
	remainingEffortMin: number | null;
	remainingEffortMax: number | null;
	estimateConfidence: string | null;
	uncertaintiesJson: string | null;
	sourcePayloadJson: string;
}

interface SessionInput {
	id: string;
	ticketCode: string;
	startedAt: string | null;
	endedAt: string | null;
	pauseMinutes: number;
	grossMinutes: number | null;
	netMinutes: number | null;
	pointedMinutes: number | null;
	status: "active" | "paused" | "ended" | "abandoned" | "pending";
	reportText: string | null;
	payloadJson: string;
}

interface WorkLogInput {
	id: string;
	sessionId: string | null;
	ticketCode: string;
	workDate: string;
	serviceText: string;
	activityText: string;
	minutes: number;
	source: string;
}

interface CalendarBlockInput {
	id: string;
	ticketCode: string | null;
	type: "planned" | "projected" | "realized" | "reserve" | "meeting" | "break";
	status: "active" | "expired" | "cancelled" | "completed";
	title: string;
	details: string | null;
	startsAt: string;
	endsAt: string;
	source: string;
}

interface PlanningInput {
	id: string;
	horizonStart: string | null;
	horizonEnd: string | null;
	generatedAt: string;
	expiresAt: string | null;
	payloadJson: string;
	blocks: CalendarBlockInput[];
}

interface ClosingInput {
	id: string;
	date: string;
	workLogCount: number;
	totalMinutes: number;
	totalHoursText: string;
	targetMinutes: number | null;
	targetReached: number | null;
	continuitySummary: string | null;
	personaMutated: number;
	payloadJson: string;
}

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 50_000;

const EVENT_TYPES = new Set<EventType>([
	"start",
	"refresh",
	"ticket_activity_end",
	"daily_end",
]);

const FORBIDDEN_KEY_FRAGMENTS = [
	"authorization",
	"access_token",
	"refresh_token",
	"sync_token",
	"api_key",
	"password",
	"cookie",
	"secret",
	"requester_email",
	"solicitante_email",
];

const SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"Content-Type": "application/json; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const requestId = crypto.randomUUID();
		const url = new URL(request.url);

		try {
			if (request.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: {
						Allow: "GET, POST, OPTIONS",
						"Cache-Control": "no-store",
					},
				});
			}

			if (request.method === "GET" && url.pathname === "/") {
				return jsonResponse(
					{
						service: "opera-sync-gateway",
						status: "online",
						version: "0.1.0",
						endpoints: [
							"GET /v1/health",
							"GET /v1/state",
							"GET /v1/tickets/:codigo",
							"POST /v1/events",
							"POST /v1/import",
						],
						request_id: requestId,
					},
					200,
				);
			}

			if (request.method === "GET" && url.pathname === "/v1/health") {
				return await handleHealth(env, requestId);
			}

			if (request.method === "GET" && url.pathname === "/v1/state") {
				const auth = await authorize(request, env, ["site", "admin"]);
				if (!auth.ok) return auth.response;
				return await handleState(env, requestId);
			}

			if (
				request.method === "GET" &&
				url.pathname.startsWith("/v1/tickets/")
			) {
				const auth = await authorize(request, env, ["site", "admin"]);
				if (!auth.ok) return auth.response;

				const code = decodeURIComponent(
					url.pathname.slice("/v1/tickets/".length),
				).trim();

				if (!code) {
					return errorResponse(
						400,
						"invalid_ticket_code",
						"Código do chamado não informado.",
						requestId,
					);
				}

				return await handleTicket(env, code, requestId);
			}

			if (request.method === "POST" && url.pathname === "/v1/events") {
				const auth = await authorize(request, env, ["admin"]);
				if (!auth.ok) return auth.response;
				return await handleEventPost(request, env, requestId, "admin_api");
			}

			if (request.method === "POST" && url.pathname === "/v1/import") {
				const auth = await authorize(request, env, ["site", "admin"]);
				if (!auth.ok) return auth.response;
				return await handleEventPost(request, env, requestId, "site_import");
			}

			return errorResponse(
				404,
				"not_found",
				"Rota não encontrada.",
				requestId,
			);
		} catch {
			return errorResponse(
				500,
				"server_error",
				"Falha interna no processamento.",
				requestId,
			);
		}
	},
} satisfies ExportedHandler<Env>;

async function handleHealth(env: Env, requestId: string): Promise<Response> {
	const row = await env.DB.prepare(
		`SELECT
			MAX(CASE WHEN state_key = 'schema_version' THEN state_value END) AS schema_version,
			MAX(CASE WHEN state_key = 'gateway_status' THEN state_value END) AS gateway_status
		 FROM gateway_state`,
	).first<Record<string, unknown>>();

	return jsonResponse(
		{
			status: "ok",
			service: "opera-sync-gateway",
			version: "0.1.0",
			database: {
				connected: true,
				schema_version: row?.schema_version ?? null,
				gateway_status: row?.gateway_status ?? null,
			},
			time: new Date().toISOString(),
			request_id: requestId,
		},
		200,
	);
}

async function handleState(env: Env, requestId: string): Promise<Response> {
	const results = await env.DB.batch([
		env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM opera_events) AS events,
				(SELECT COUNT(*) FROM tickets) AS tickets,
				(SELECT COUNT(*) FROM tickets WHERE active = 1) AS active_tickets,
				(SELECT COUNT(*) FROM work_logs) AS work_logs,
				(SELECT COUNT(*) FROM planning_versions) AS planning_versions,
				(SELECT COUNT(*) FROM calendar_blocks) AS calendar_blocks,
				(SELECT COUNT(*) FROM tombstones) AS tombstones,
				(SELECT COUNT(*) FROM daily_closings) AS daily_closings
		`),
		env.DB.prepare(`
			SELECT event_id, schema_version, opera_version, event_type,
			       generated_at, received_at, processing_status, source
			FROM opera_events
			ORDER BY received_at DESC
			LIMIT 1
		`),
		env.DB.prepare(`
			SELECT ticket_code, title, display_summary, formal_status,
			       analytical_classification, active, opened_at, due_at,
			       closed_at, current_revision, updated_at
			FROM tickets
			ORDER BY active DESC, ticket_code
			LIMIT 1000
		`),
		env.DB.prepare(`
			SELECT planning_version_id, planning_id, event_id, version_number,
			       is_current, horizon_start, horizon_end, generated_at,
			       expires_at, payload_json
			FROM planning_versions
			WHERE is_current = 1
			ORDER BY generated_at DESC
		`),
		env.DB.prepare(`
			SELECT block_id, planning_version_id, event_id, ticket_code,
			       block_type, block_status, title, details,
			       starts_at, ends_at, source
			FROM calendar_blocks
			WHERE block_status = 'active'
			ORDER BY starts_at
			LIMIT 2500
		`),
		env.DB.prepare(`
			SELECT closing_id, event_id, closing_date, work_log_count,
			       total_minutes, total_hours_text, target_minutes,
			       target_reached, continuity_summary, persona_mutated,
			       created_at
			FROM daily_closings
			ORDER BY closing_date DESC, created_at DESC
			LIMIT 1
		`),
	]);

	const counts = firstRow(results[0]) ?? {};
	const latestEvent = firstRow(results[1]);
	const tickets = resultRows(results[2]);
	const planningVersions = resultRows(results[3]).map((row) => ({
		...row,
		payload: safeJsonParse(row.payload_json),
		payload_json: undefined,
	}));
	const blocks = resultRows(results[4]);
	const latestClosing = firstRow(results[5]);

	return jsonResponse(
		{
			status: "ok",
			generated_at: new Date().toISOString(),
			counts,
			latest_event: latestEvent,
			tickets,
			current_planning_versions: planningVersions,
			calendar_blocks: blocks,
			latest_closing: latestClosing,
			request_id: requestId,
		},
		200,
	);
}

async function handleTicket(
	env: Env,
	code: string,
	requestId: string,
): Promise<Response> {
	const results = await env.DB.batch([
		env.DB.prepare(`
			SELECT ticket_code, title, display_summary, formal_status,
			       analytical_classification, active, opened_at, due_at,
			       closed_at, current_revision, first_seen_event_id,
			       last_seen_event_id, created_at, updated_at
			FROM tickets
			WHERE ticket_code = ?
		`).bind(code),
		env.DB.prepare(`
			SELECT revision_id, ticket_code, event_id, revision_number,
			       formal_status, active, title, original_request,
			       relevant_evolution, relevant_decisions_json,
			       last_real_advance, current_situation, dependencies_json,
			       pending_items_json, next_step, natural_summary,
			       complexity, remaining_effort_min, remaining_effort_max,
			       estimate_confidence, uncertainties_json, created_at
			FROM ticket_revisions
			WHERE ticket_code = ?
			ORDER BY revision_number DESC
			LIMIT 100
		`).bind(code),
		env.DB.prepare(`
			SELECT session_id, event_id, ticket_code, started_at, ended_at,
			       pause_minutes, gross_minutes, net_minutes,
			       pointed_minutes, session_status, report_text,
			       created_at, updated_at
			FROM sessions
			WHERE ticket_code = ?
			ORDER BY COALESCE(started_at, created_at) DESC
			LIMIT 200
		`).bind(code),
		env.DB.prepare(`
			SELECT work_log_id, event_id, session_id, ticket_code,
			       work_date, service_text, activity_text, minutes,
			       source, created_at
			FROM work_logs
			WHERE ticket_code = ?
			ORDER BY work_date DESC, created_at DESC
			LIMIT 500
		`).bind(code),
		env.DB.prepare(`
			SELECT block_id, planning_version_id, event_id, ticket_code,
			       block_type, block_status, title, details,
			       starts_at, ends_at, source, created_at
			FROM calendar_blocks
			WHERE ticket_code = ?
			ORDER BY starts_at DESC
			LIMIT 500
		`).bind(code),
		env.DB.prepare(`
			SELECT tombstone_id, event_id, ticket_code, detected_at,
			       state, source_snapshot_complete, created_at
			FROM tombstones
			WHERE ticket_code = ?
			ORDER BY detected_at DESC
			LIMIT 100
		`).bind(code),
	]);

	const ticket = firstRow(results[0]);
	if (!ticket) {
		return errorResponse(
			404,
			"ticket_not_found",
			"Chamado não encontrado.",
			requestId,
		);
	}

	const revisions = resultRows(results[1]).map((row) => ({
		...row,
		relevant_decisions: safeJsonParse(row.relevant_decisions_json),
		dependencies: safeJsonParse(row.dependencies_json),
		pending_items: safeJsonParse(row.pending_items_json),
		uncertainties: safeJsonParse(row.uncertainties_json),
		relevant_decisions_json: undefined,
		dependencies_json: undefined,
		pending_items_json: undefined,
		uncertainties_json: undefined,
	}));

	return jsonResponse(
		{
			status: "ok",
			ticket,
			revisions,
			sessions: resultRows(results[2]),
			work_logs: resultRows(results[3]),
			calendar_blocks: resultRows(results[4]),
			tombstones: resultRows(results[5]),
			request_id: requestId,
		},
		200,
	);
}

async function handleEventPost(
	request: Request,
	env: Env,
	requestId: string,
	source: string,
): Promise<Response> {
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json")) {
		return errorResponse(
			415,
			"unsupported_media_type",
			"Use Content-Type application/json.",
			requestId,
		);
	}

	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_EVENT_BYTES) {
		return errorResponse(
			413,
			"payload_too_large",
			"O evento excede o limite permitido.",
			requestId,
		);
	}

	const bodyText = await request.text();
	const actualLength = new TextEncoder().encode(bodyText).byteLength;
	if (actualLength === 0) {
		return errorResponse(
			400,
			"empty_payload",
			"O corpo da requisição está vazio.",
			requestId,
		);
	}
	if (actualLength > MAX_EVENT_BYTES) {
		return errorResponse(
			413,
			"payload_too_large",
			"O evento excede o limite permitido.",
			requestId,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return errorResponse(
			400,
			"invalid_json",
			"O corpo não contém JSON válido.",
			requestId,
		);
	}

	const validation = validateOperaEvent(parsed);
	if (!validation.ok) {
		return jsonResponse(
			{
				status: "invalid_payload",
				errors: validation.errors,
				request_id: requestId,
			},
			400,
		);
	}

	const event = parsed as OperaEvent;
	const idempotencyKey = request.headers.get("idempotency-key")?.trim();

	if (!idempotencyKey || idempotencyKey !== event.event_id) {
		return errorResponse(
			400,
			"idempotency_key_mismatch",
			"Idempotency-Key deve ser igual a event_id.",
			requestId,
		);
	}

	return await ingestEvent(env, event, requestId, source);
}

async function ingestEvent(
	env: Env,
	event: OperaEvent,
	requestId: string,
	source: string,
): Promise<Response> {
	const canonicalPayload = stableStringify(event);
	const payloadHash = await sha256Hex(canonicalPayload);

	const existing = await env.DB.prepare(`
		SELECT e.event_id, e.payload_hash, p.result_status, p.processed_at
		FROM opera_events e
		LEFT JOIN processed_events p ON p.event_id = e.event_id
		WHERE e.event_id = ?
	`).bind(event.event_id).first<Record<string, unknown>>();

	if (existing) {
		if (existing.payload_hash !== payloadHash) {
			return errorResponse(
				409,
				"event_id_conflict",
				"O event_id já existe com conteúdo diferente.",
				requestId,
			);
		}

		return jsonResponse(
			{
				status: "duplicate",
				event_id: event.event_id,
				duplicate: true,
				processed_at: existing.processed_at ?? null,
				request_id: requestId,
			},
			200,
		);
	}

	const extracted = extractEventData(event);
	const now = new Date().toISOString();
	const statements: D1PreparedStatement[] = [];

	statements.push(
		env.DB.prepare(`
			INSERT INTO opera_events (
				event_id, schema_version, opera_version, event_type,
				generated_at, received_at, payload_hash, payload_json,
				processing_status, request_id, source
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processed', ?, ?)
		`).bind(
			event.event_id,
			event.schema_version,
			event.opera_version,
			event.tipo_evento,
			event.gerado_em,
			now,
			payloadHash,
			canonicalPayload,
			requestId,
			source,
		),
	);

	const relatedTicketCodes = new Set<string>();
	for (const ticket of extracted.tickets) relatedTicketCodes.add(ticket.code);
	for (const session of extracted.sessions) relatedTicketCodes.add(session.ticketCode);
	for (const workLog of extracted.workLogs) relatedTicketCodes.add(workLog.ticketCode);
	for (const block of extracted.planning?.blocks ?? []) {
		if (block.ticketCode) relatedTicketCodes.add(block.ticketCode);
	}

	for (const code of relatedTicketCodes) {
		if (!extracted.tickets.some((ticket) => ticket.code === code)) {
			statements.push(
				env.DB.prepare(`
					INSERT INTO tickets (
						ticket_code, active, current_revision,
						first_seen_event_id, last_seen_event_id,
						created_at, updated_at
					) VALUES (?, 1, 0, ?, ?, ?, ?)
					ON CONFLICT(ticket_code) DO UPDATE SET
						last_seen_event_id = excluded.last_seen_event_id,
						updated_at = excluded.updated_at
				`).bind(code, event.event_id, event.event_id, now, now),
			);
		}
	}

	for (const ticket of extracted.tickets) {
		statements.push(
			env.DB.prepare(`
				INSERT INTO tickets (
					ticket_code, title, display_summary, formal_status,
					analytical_classification, active, opened_at, due_at,
					closed_at, current_revision, first_seen_event_id,
					last_seen_event_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
				ON CONFLICT(ticket_code) DO UPDATE SET
					title = COALESCE(excluded.title, tickets.title),
					display_summary = COALESCE(excluded.display_summary, tickets.display_summary),
					formal_status = COALESCE(excluded.formal_status, tickets.formal_status),
					analytical_classification = COALESCE(
						excluded.analytical_classification,
						tickets.analytical_classification
					),
					active = excluded.active,
					opened_at = COALESCE(excluded.opened_at, tickets.opened_at),
					due_at = COALESCE(excluded.due_at, tickets.due_at),
					closed_at = CASE
						WHEN excluded.active = 1 THEN NULL
						ELSE COALESCE(excluded.closed_at, tickets.closed_at)
					END,
					last_seen_event_id = excluded.last_seen_event_id,
					updated_at = excluded.updated_at
			`).bind(
				ticket.code,
				ticket.title,
				ticket.summary,
				ticket.formalStatus,
				ticket.classification,
				ticket.active,
				ticket.openedAt,
				ticket.dueAt,
				ticket.closedAt,
				event.event_id,
				event.event_id,
				now,
				now,
			),
		);

		statements.push(
			env.DB.prepare(`
				INSERT INTO ticket_revisions (
					ticket_code, event_id, revision_number, formal_status,
					active, title, original_request, relevant_evolution,
					relevant_decisions_json, last_real_advance,
					current_situation, dependencies_json, pending_items_json,
					next_step, natural_summary, complexity,
					remaining_effort_min, remaining_effort_max,
					estimate_confidence, uncertainties_json,
					source_payload_json, created_at
				)
				SELECT
					?, ?, current_revision + 1, ?, ?, ?, ?, ?, ?, ?, ?,
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				FROM tickets
				WHERE ticket_code = ?
			`).bind(
				ticket.code,
				event.event_id,
				ticket.formalStatus,
				ticket.active,
				ticket.title,
				ticket.originalRequest,
				ticket.relevantEvolution,
				ticket.relevantDecisionsJson,
				ticket.lastRealAdvance,
				ticket.currentSituation,
				ticket.dependenciesJson,
				ticket.pendingItemsJson,
				ticket.nextStep,
				ticket.naturalSummary,
				ticket.complexity,
				ticket.remainingEffortMin,
				ticket.remainingEffortMax,
				ticket.estimateConfidence,
				ticket.uncertaintiesJson,
				ticket.sourcePayloadJson,
				now,
				ticket.code,
			),
		);

		statements.push(
			env.DB.prepare(`
				UPDATE tickets
				SET current_revision = current_revision + 1,
				    updated_at = ?
				WHERE ticket_code = ?
			`).bind(now, ticket.code),
		);
	}

	if (extracted.snapshotComplete) {
		if (extracted.tickets.length === 0) {
			statements.push(
				env.DB.prepare(`
					INSERT OR IGNORE INTO tombstones (
						event_id, ticket_code, detected_at,
						state, source_snapshot_complete, created_at
					)
					SELECT ?, ticket_code, ?,
					       'fechado_detectado_por_ausencia', 1, ?
					FROM tickets
					WHERE active = 1
				`).bind(event.event_id, event.gerado_em, now),
			);
			statements.push(
				env.DB.prepare(`
					UPDATE tickets
					SET active = 0,
					    closed_at = COALESCE(closed_at, ?),
					    updated_at = ?
					WHERE active = 1
				`).bind(event.gerado_em, now),
			);
		} else {
			const placeholders = extracted.tickets.map(() => "?").join(", ");
			const codes = extracted.tickets.map((ticket) => ticket.code);

			statements.push(
				env.DB.prepare(`
					INSERT OR IGNORE INTO tombstones (
						event_id, ticket_code, detected_at,
						state, source_snapshot_complete, created_at
					)
					SELECT ?, ticket_code, ?,
					       'fechado_detectado_por_ausencia', 1, ?
					FROM tickets
					WHERE active = 1
					  AND ticket_code NOT IN (${placeholders})
				`).bind(event.event_id, event.gerado_em, now, ...codes),
			);

			statements.push(
				env.DB.prepare(`
					UPDATE tickets
					SET active = 0,
					    closed_at = COALESCE(closed_at, ?),
					    updated_at = ?
					WHERE active = 1
					  AND ticket_code NOT IN (${placeholders})
				`).bind(event.gerado_em, now, ...codes),
			);
		}
	}

	for (const session of extracted.sessions) {
		statements.push(
			env.DB.prepare(`
				INSERT INTO sessions (
					session_id, event_id, ticket_code, started_at,
					ended_at, pause_minutes, gross_minutes, net_minutes,
					pointed_minutes, session_status, report_text,
					payload_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					event_id = excluded.event_id,
					ticket_code = excluded.ticket_code,
					started_at = COALESCE(excluded.started_at, sessions.started_at),
					ended_at = excluded.ended_at,
					pause_minutes = excluded.pause_minutes,
					gross_minutes = excluded.gross_minutes,
					net_minutes = excluded.net_minutes,
					pointed_minutes = excluded.pointed_minutes,
					session_status = excluded.session_status,
					report_text = COALESCE(excluded.report_text, sessions.report_text),
					payload_json = excluded.payload_json,
					updated_at = excluded.updated_at
			`).bind(
				session.id,
				event.event_id,
				session.ticketCode,
				session.startedAt,
				session.endedAt,
				session.pauseMinutes,
				session.grossMinutes,
				session.netMinutes,
				session.pointedMinutes,
				session.status,
				session.reportText,
				session.payloadJson,
				now,
				now,
			),
		);
	}

	for (const workLog of extracted.workLogs) {
		statements.push(
			env.DB.prepare(`
				INSERT INTO work_logs (
					work_log_id, event_id, session_id, ticket_code,
					work_date, service_text, activity_text, minutes,
					source, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(work_log_id) DO UPDATE SET
					event_id = excluded.event_id,
					session_id = excluded.session_id,
					ticket_code = excluded.ticket_code,
					work_date = excluded.work_date,
					service_text = excluded.service_text,
					activity_text = excluded.activity_text,
					minutes = excluded.minutes,
					source = excluded.source
			`).bind(
				workLog.id,
				event.event_id,
				workLog.sessionId,
				workLog.ticketCode,
				workLog.workDate,
				workLog.serviceText,
				workLog.activityText,
				workLog.minutes,
				workLog.source,
				now,
			),
		);
	}

	if (extracted.planning) {
		const planning = extracted.planning;

		statements.push(
			env.DB.prepare(`
				UPDATE calendar_blocks
				SET block_status = 'expired'
				WHERE planning_version_id IN (
					SELECT planning_version_id
					FROM planning_versions
					WHERE planning_id = ? AND is_current = 1
				)
				  AND block_status = 'active'
			`).bind(planning.id),
		);

		statements.push(
			env.DB.prepare(`
				UPDATE planning_versions
				SET is_current = 0
				WHERE planning_id = ? AND is_current = 1
			`).bind(planning.id),
		);

		statements.push(
			env.DB.prepare(`
				INSERT INTO planning_versions (
					planning_id, event_id, version_number, is_current,
					horizon_start, horizon_end, generated_at,
					expires_at, payload_json, created_at
				)
				SELECT ?, ?, COALESCE(MAX(version_number), 0) + 1, 1,
				       ?, ?, ?, ?, ?, ?
				FROM planning_versions
				WHERE planning_id = ?
			`).bind(
				planning.id,
				event.event_id,
				planning.horizonStart,
				planning.horizonEnd,
				planning.generatedAt,
				planning.expiresAt,
				planning.payloadJson,
				now,
				planning.id,
			),
		);

		for (const block of planning.blocks) {
			statements.push(
				env.DB.prepare(`
					INSERT INTO calendar_blocks (
						block_id, planning_version_id, event_id,
						ticket_code, block_type, block_status, title,
						details, starts_at, ends_at, source, created_at
					)
					SELECT ?, planning_version_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					FROM planning_versions
					WHERE planning_id = ? AND event_id = ?
					ORDER BY planning_version_id DESC
					LIMIT 1
					ON CONFLICT(block_id) DO UPDATE SET
						planning_version_id = excluded.planning_version_id,
						event_id = excluded.event_id,
						ticket_code = excluded.ticket_code,
						block_type = excluded.block_type,
						block_status = excluded.block_status,
						title = excluded.title,
						details = excluded.details,
						starts_at = excluded.starts_at,
						ends_at = excluded.ends_at,
						source = excluded.source
				`).bind(
					block.id,
					event.event_id,
					block.ticketCode,
					block.type,
					block.status,
					block.title,
					block.details,
					block.startsAt,
					block.endsAt,
					block.source,
					now,
					planning.id,
					event.event_id,
				),
			);
		}
	}

	if (extracted.closing) {
		const closing = extracted.closing;
		statements.push(
			env.DB.prepare(`
				INSERT INTO daily_closings (
					closing_id, event_id, closing_date, work_log_count,
					total_minutes, total_hours_text, target_minutes,
					target_reached, continuity_summary, persona_mutated,
					payload_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(closing_id) DO UPDATE SET
					event_id = excluded.event_id,
					closing_date = excluded.closing_date,
					work_log_count = excluded.work_log_count,
					total_minutes = excluded.total_minutes,
					total_hours_text = excluded.total_hours_text,
					target_minutes = excluded.target_minutes,
					target_reached = excluded.target_reached,
					continuity_summary = excluded.continuity_summary,
					persona_mutated = excluded.persona_mutated,
					payload_json = excluded.payload_json
			`).bind(
				closing.id,
				event.event_id,
				closing.date,
				closing.workLogCount,
				closing.totalMinutes,
				closing.totalHoursText,
				closing.targetMinutes,
				closing.targetReached,
				closing.continuitySummary,
				closing.personaMutated,
				closing.payloadJson,
				now,
			),
		);
	}

	statements.push(
		env.DB.prepare(`
			INSERT INTO processed_events (
				event_id, payload_hash, processed_at, result_status
			) VALUES (?, ?, ?, 'created')
		`).bind(event.event_id, payloadHash, now),
	);

	try {
		await env.DB.batch(statements);
	} catch {
		const concurrent = await env.DB.prepare(`
			SELECT payload_hash
			FROM opera_events
			WHERE event_id = ?
		`).bind(event.event_id).first<Record<string, unknown>>();

		if (concurrent?.payload_hash === payloadHash) {
			return jsonResponse(
				{
					status: "duplicate",
					event_id: event.event_id,
					duplicate: true,
					request_id: requestId,
				},
				200,
			);
		}

		return errorResponse(
			500,
			"database_write_failed",
			"Não foi possível concluir a gravação do evento.",
			requestId,
		);
	}

	const planningVersion = extracted.planning
		? await env.DB.prepare(`
			SELECT version_number
			FROM planning_versions
			WHERE planning_id = ? AND event_id = ?
			ORDER BY planning_version_id DESC
			LIMIT 1
		`).bind(extracted.planning.id, event.event_id)
			.first<Record<string, unknown>>()
		: null;

	return jsonResponse(
		{
			status: "created",
			event_id: event.event_id,
			duplicate: false,
			planning_version: planningVersion?.version_number ?? null,
			records_changed: {
				tickets: extracted.tickets.length,
				sessions: extracted.sessions.length,
				work_logs: extracted.workLogs.length,
				calendar_blocks: extracted.planning?.blocks.length ?? 0,
				daily_closing: extracted.closing ? 1 : 0,
				snapshot_complete: extracted.snapshotComplete,
			},
			processed_at: now,
			request_id: requestId,
		},
		201,
	);
}

function extractEventData(event: OperaEvent): {
	tickets: TicketInput[];
	sessions: SessionInput[];
	workLogs: WorkLogInput[];
	planning: PlanningInput | null;
	closing: ClosingInput | null;
	snapshotComplete: boolean;
} {
	const data = event.dados;
	const snapshot =
		asRecord(data.fotografia_formal) ??
		asRecord(data.fotografia) ??
		asRecord(data.snapshot);

	const rawTickets =
		asArray(snapshot?.tickets) ??
		asArray(data.tickets) ??
		asArray(data.chamados) ??
		[];

	const snapshotComplete =
		getBoolean(snapshot, ["completa", "complete", "fotografia_completa"]) ??
		getBoolean(data, ["fotografia_completa", "snapshot_complete"]) ??
		false;

	const tickets = rawTickets
		.map((item) => extractTicket(item))
		.filter((item): item is TicketInput => item !== null);

	const rawSessions = asArray(data.sessoes) ?? asArray(data.sessions) ?? [];
	const sessions = rawSessions
		.map((item, index) => extractSession(item, event.event_id, index))
		.filter((item): item is SessionInput => item !== null);

	const rawWorkLogs =
		asArray(data.apontamentos) ??
		asArray(data.work_logs) ??
		asArray(data.registros) ??
		[];
	const workLogs = rawWorkLogs
		.map((item, index) => extractWorkLog(item, event, index))
		.filter((item): item is WorkLogInput => item !== null);

	const planningRecord =
		asRecord(data.planejamento) ?? asRecord(data.planning);
	const planning = planningRecord
		? extractPlanning(planningRecord, event)
		: null;

	const closingRecord =
		asRecord(data.fechamento) ?? asRecord(data.daily_closing);
	const closing = closingRecord
		? extractClosing(closingRecord, event)
		: null;

	return {
		tickets,
		sessions,
		workLogs,
		planning,
		closing,
		snapshotComplete,
	};
}

function extractTicket(value: unknown): TicketInput | null {
	const row = asRecord(value);
	if (!row) return null;

	const code = getString(row, ["codigo", "ticket_code", "code"]);
	if (!code) return null;

	const synthesis =
		asRecord(row.sintese) ??
		asRecord(row.synthesis) ??
		asRecord(row.resumo);

	const activeBoolean = getBoolean(row, ["ativo", "active"]);
	const formalStatus = getString(row, [
		"status_formal",
		"formal_status",
		"status",
	]);

	const active =
		activeBoolean !== null
			? activeBoolean
				? 1
				: 0
			: isClosedStatus(formalStatus)
				? 0
				: 1;

	const naturalSummary =
		getString(synthesis, [
			"resumo_natural",
			"natural_summary",
			"sintese_natural",
		]) ??
		getString(row, [
			"resumo_natural",
			"natural_summary",
			"display_summary",
			"descricao_minimizada",
		]);

	return {
		code,
		title: getString(row, ["titulo", "title", "nome"]),
		summary: naturalSummary,
		formalStatus,
		classification: getString(row, [
			"classificacao_analitica",
			"analytical_classification",
			"categoria_analitica",
		]),
		active,
		openedAt: getString(row, ["aberto_em", "opened_at", "created_at"]),
		dueAt: getString(row, ["prazo", "due_at", "vencimento"]),
		closedAt: getString(row, ["fechado_em", "closed_at"]),
		originalRequest:
			getString(synthesis, ["solicitacao_original", "original_request"]) ??
			getString(row, ["solicitacao_original", "original_request"]),
		relevantEvolution:
			getString(synthesis, ["evolucao_resumida", "relevant_evolution"]) ??
			getString(row, ["evolucao_resumida", "relevant_evolution"]),
		relevantDecisionsJson: jsonStringOrNull(
			getValue(synthesis, ["decisoes_relevantes", "relevant_decisions"]) ??
				getValue(row, ["decisoes_relevantes", "relevant_decisions"]),
		),
		lastRealAdvance:
			getString(synthesis, ["ultimo_avanco", "last_real_advance"]) ??
			getString(row, ["ultimo_avanco", "last_real_advance"]),
		currentSituation:
			getString(synthesis, ["situacao_atual", "current_situation"]) ??
			getString(row, ["situacao_atual", "current_situation"]),
		dependenciesJson: jsonStringOrNull(
			getValue(synthesis, ["dependencias", "dependencies"]) ??
				getValue(row, ["dependencias", "dependencies"]),
		),
		pendingItemsJson: jsonStringOrNull(
			getValue(synthesis, ["pendencias", "pending_items"]) ??
				getValue(row, ["pendencias", "pending_items"]),
		),
		nextStep:
			getString(synthesis, ["proximo_passo", "next_step"]) ??
			getString(row, ["proximo_passo", "next_step"]),
		naturalSummary,
		complexity: getString(row, ["complexidade", "complexity"]),
		remainingEffortMin: getNumber(row, [
			"esforco_restante_min",
			"remaining_effort_min",
		]),
		remainingEffortMax: getNumber(row, [
			"esforco_restante_max",
			"remaining_effort_max",
		]),
		estimateConfidence: getString(row, [
			"confianca_estimativa",
			"estimate_confidence",
			"confianca",
		]),
		uncertaintiesJson: jsonStringOrNull(
			getValue(row, ["incertezas", "uncertainties"]),
		),
		sourcePayloadJson: JSON.stringify(row),
	};
}

function extractSession(
	value: unknown,
	eventId: string,
	index: number,
): SessionInput | null {
	const row = asRecord(value);
	if (!row) return null;

	const ticketCode = getString(row, [
		"codigo",
		"ticket_code",
		"chamado",
	]);
	if (!ticketCode) return null;

	const rawStatus = (
		getString(row, ["status", "session_status", "estado"]) ?? "pending"
	).toLowerCase();

	const statusMap: Record<string, SessionInput["status"]> = {
		ativo: "active",
		active: "active",
		pausado: "paused",
		paused: "paused",
		encerrado: "ended",
		ended: "ended",
		finalizado: "ended",
		abandonado: "abandoned",
		abandoned: "abandoned",
		pendente: "pending",
		pending: "pending",
	};

	return {
		id:
			getString(row, ["session_id", "sessao_id", "id"]) ??
			`${eventId}:session:${index + 1}`,
		ticketCode,
		startedAt: getString(row, [
			"inicio",
			"inicio_real",
			"started_at",
		]),
		endedAt: getString(row, ["fim", "fim_real", "ended_at"]),
		pauseMinutes:
			getNumber(row, ["pausa_minutos", "pause_minutes"]) ?? 0,
		grossMinutes: getNumber(row, [
			"minutos_brutos",
			"gross_minutes",
		]),
		netMinutes: getNumber(row, ["minutos_liquidos", "net_minutes"]),
		pointedMinutes: getNumber(row, [
			"tempo_apontado",
			"pointed_minutes",
		]),
		status: statusMap[rawStatus] ?? "pending",
		reportText: getString(row, ["relato", "report_text"]),
		payloadJson: JSON.stringify(row),
	};
}

function extractWorkLog(
	value: unknown,
	event: OperaEvent,
	index: number,
): WorkLogInput | null {
	const row = asRecord(value);
	if (!row) return null;

	const ticketCode = getString(row, [
		"codigo",
		"ticket_code",
		"chamado",
	]);
	if (!ticketCode) return null;

	const minutes =
		getNumber(row, ["tempo", "minutos", "minutes"]) ?? 0;
	if (minutes < 0) return null;

	const date =
		getString(row, ["data", "work_date"]) ??
		event.gerado_em.slice(0, 10);

	return {
		id:
			getString(row, [
				"work_log_id",
				"apontamento_id",
				"registro_id",
				"id",
			]) ?? `${event.event_id}:work-log:${index + 1}`,
		sessionId: getString(row, ["session_id", "sessao_id"]),
		ticketCode,
		workDate: date.slice(0, 10),
		serviceText:
			getString(row, ["atendimento", "service_text"]) ??
			"Atividade registrada",
		activityText:
			getString(row, ["atividade", "activity_text"]) ??
			"Atividade operacional",
		minutes: Math.trunc(minutes),
		source: getString(row, ["origem", "source"]) ?? "opera",
	};
}

function extractPlanning(
	row: JsonRecord,
	event: OperaEvent,
): PlanningInput {
	const rawBlocks =
		asArray(row.blocos) ??
		asArray(row.calendar_blocks) ??
		asArray(row.agenda) ??
		[];

	const blocks = rawBlocks
		.map((item, index) => extractCalendarBlock(item, event.event_id, index))
		.filter((item): item is CalendarBlockInput => item !== null);

	return {
		id:
			getString(row, ["planejamento_id", "planning_id", "id"]) ??
			"opera-main",
		horizonStart: getString(row, [
			"horizonte_inicio",
			"horizon_start",
			"inicio",
		]),
		horizonEnd: getString(row, [
			"horizonte_fim",
			"horizon_end",
			"fim",
		]),
		generatedAt:
			getString(row, ["gerado_em", "generated_at"]) ??
			event.gerado_em,
		expiresAt: getString(row, ["expira_em", "expires_at"]),
		payloadJson: JSON.stringify(row),
		blocks,
	};
}

function extractCalendarBlock(
	value: unknown,
	eventId: string,
	index: number,
): CalendarBlockInput | null {
	const row = asRecord(value);
	if (!row) return null;

	const startsAt = getString(row, [
		"inicio",
		"starts_at",
		"start",
	]);
	const endsAt = getString(row, ["fim", "ends_at", "end"]);
	if (!startsAt || !endsAt || endsAt <= startsAt) return null;

	const rawType = (
		getString(row, ["tipo", "block_type", "estado_visual"]) ?? "planned"
	).toLowerCase();

	const typeMap: Record<string, CalendarBlockInput["type"]> = {
		planejado: "planned",
		planned: "planned",
		projetado: "projected",
		projected: "projected",
		realizado: "realized",
		realized: "realized",
		reserva: "reserve",
		reserve: "reserve",
		reuniao: "meeting",
		reunião: "meeting",
		meeting: "meeting",
		pausa: "break",
		break: "break",
		almoco: "break",
		almoço: "break",
	};

	const rawStatus = (
		getString(row, ["status", "block_status"]) ?? "active"
	).toLowerCase();

	const statusMap: Record<string, CalendarBlockInput["status"]> = {
		ativo: "active",
		active: "active",
		expirado: "expired",
		expired: "expired",
		cancelado: "cancelled",
		cancelled: "cancelled",
		concluido: "completed",
		concluído: "completed",
		completed: "completed",
	};

	return {
		id:
			getString(row, ["block_id", "bloco_id", "id"]) ??
			`${eventId}:block:${index + 1}`,
		ticketCode: getString(row, [
			"codigo",
			"ticket_code",
			"chamado",
		]),
		type: typeMap[rawType] ?? "planned",
		status: statusMap[rawStatus] ?? "active",
		title:
			getString(row, ["titulo", "title", "atividade"]) ??
			"Bloco OPERA",
		details: getString(row, ["detalhes", "details", "descricao"]),
		startsAt,
		endsAt,
		source: getString(row, ["origem", "source"]) ?? "opera",
	};
}

function extractClosing(
	row: JsonRecord,
	event: OperaEvent,
): ClosingInput {
	const metrics =
		asRecord(row.metricas) ??
		asRecord(event.dados.metricas) ??
		{};

	const totalMinutes =
		getNumber(metrics, ["total_minutos", "total_minutes", "minutos"]) ??
		getNumber(row, ["total_minutos", "total_minutes"]) ??
		0;

	const targetReachedBoolean =
		getBoolean(metrics, ["meta_atingida", "target_reached"]) ??
		getBoolean(row, ["meta_atingida", "target_reached"]);

	return {
		id:
			getString(row, ["fechamento_id", "closing_id", "id"]) ??
			event.event_id,
		date:
			(
				getString(row, ["data", "closing_date"]) ??
				event.gerado_em.slice(0, 10)
			).slice(0, 10),
		workLogCount:
			getNumber(metrics, [
				"quantidade_apontamentos",
				"work_log_count",
				"apontamentos",
			]) ??
			getNumber(row, ["quantidade_apontamentos", "work_log_count"]) ??
			0,
		totalMinutes: Math.trunc(totalMinutes),
		totalHoursText:
			getString(metrics, ["total_horas", "total_hours_text", "horas"]) ??
			getString(row, ["total_horas", "total_hours_text"]) ??
			formatHours(totalMinutes),
		targetMinutes:
			getNumber(metrics, ["meta_minutos", "target_minutes"]) ??
			getNumber(row, ["meta_minutos", "target_minutes"]),
		targetReached:
			targetReachedBoolean === null
				? null
				: targetReachedBoolean
					? 1
					: 0,
		continuitySummary:
			getString(row, [
				"resumo_continuidade",
				"continuity_summary",
			]) ??
			getString(event.dados, [
				"resumo_continuidade",
				"continuity_summary",
			]),
		personaMutated:
			getBoolean(row, ["persona_mutada", "persona_mutated"]) === true
				? 1
				: 0,
		payloadJson: JSON.stringify(row),
	};
}

function validateOperaEvent(value: unknown): ValidationResult {
	const errors: string[] = [];
	const event = asRecord(value);

	if (!event) {
		return {
			ok: false,
			errors: ["O documento raiz deve ser um objeto JSON."],
		};
	}

	const schemaVersion = getString(event, ["schema_version"]);
	const operaVersion = getString(event, ["opera_version"]);
	const eventId = getString(event, ["event_id"]);
	const eventType = getString(event, ["tipo_evento"]);
	const generatedAt = getString(event, ["gerado_em"]);

	if (!schemaVersion) errors.push("schema_version é obrigatório.");
	if (!operaVersion) errors.push("opera_version é obrigatório.");

	if (!eventId) {
		errors.push("event_id é obrigatório.");
	} else {
		if (eventId.length > 200) {
			errors.push("event_id excede 200 caracteres.");
		}
		if (!/^[A-Za-z0-9._:-]+$/.test(eventId)) {
			errors.push("event_id contém caracteres inválidos.");
		}
	}

	if (!eventType || !EVENT_TYPES.has(eventType as EventType)) {
		errors.push("tipo_evento é inválido.");
	}

	if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
		errors.push("gerado_em deve ser uma data ISO-8601 válida.");
	}

	if (!asRecord(event.dados)) {
		errors.push("dados deve ser um objeto.");
	}

	if (!asRecord(event.integridade)) {
		errors.push("integridade deve ser um objeto.");
	}

	const traversal = inspectJson(value);
	if (traversal.tooDeep) {
		errors.push(`O JSON excede a profundidade máxima de ${MAX_JSON_DEPTH}.`);
	}
	if (traversal.tooManyNodes) {
		errors.push(`O JSON excede o limite estrutural permitido.`);
	}
	if (traversal.forbiddenPaths.length > 0) {
		errors.push(
			`Campos sensíveis proibidos: ${traversal.forbiddenPaths
				.slice(0, 10)
				.join(", ")}.`,
		);
	}

	return { ok: errors.length === 0, errors };
}

function inspectJson(value: unknown): {
	tooDeep: boolean;
	tooManyNodes: boolean;
	forbiddenPaths: string[];
} {
	let nodeCount = 0;
	let tooDeep = false;
	let tooManyNodes = false;
	const forbiddenPaths: string[] = [];

	const visit = (current: unknown, path: string, depth: number): void => {
		nodeCount += 1;
		if (nodeCount > MAX_JSON_NODES) {
			tooManyNodes = true;
			return;
		}
		if (depth > MAX_JSON_DEPTH) {
			tooDeep = true;
			return;
		}

		if (Array.isArray(current)) {
			for (let index = 0; index < current.length; index += 1) {
				visit(current[index], `${path}[${index}]`, depth + 1);
				if (tooManyNodes) return;
			}
			return;
		}

		const record = asRecord(current);
		if (!record) return;

		for (const [key, child] of Object.entries(record)) {
			const normalized = key.toLowerCase();
			if (
				FORBIDDEN_KEY_FRAGMENTS.some((fragment) =>
					normalized.includes(fragment),
				)
			) {
				forbiddenPaths.push(path ? `${path}.${key}` : key);
			}
			visit(child, path ? `${path}.${key}` : key, depth + 1);
			if (tooManyNodes) return;
		}
	};

	visit(value, "", 0);
	return { tooDeep, tooManyNodes, forbiddenPaths };
}

async function authorize(
	request: Request,
	env: Env,
	allowedRoles: AccessRole[],
): Promise<
	| { ok: true; role: AccessRole }
	| { ok: false; response: Response }
> {
	if (!env.OPERA_SITE_TOKEN || !env.OPERA_ADMIN_TOKEN) {
		return {
			ok: false,
			response: errorResponse(
				503,
				"gateway_misconfigured",
				"Segredos obrigatórios não configurados.",
				crypto.randomUUID(),
			),
		};
	}

	const authorization = request.headers.get("authorization") ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	const supplied = match?.[1]?.trim() ?? "";

	const siteMatch = await secureEqual(supplied, env.OPERA_SITE_TOKEN);
	const adminMatch = await secureEqual(supplied, env.OPERA_ADMIN_TOKEN);

	if (allowedRoles.includes("admin") && adminMatch) {
		return { ok: true, role: "admin" };
	}
	if (allowedRoles.includes("site") && siteMatch) {
		return { ok: true, role: "site" };
	}

	return {
		ok: false,
		response: errorResponse(
			401,
			"unauthorized",
			"Credencial inválida.",
			crypto.randomUUID(),
			{ "WWW-Authenticate": 'Bearer realm="opera-sync-gateway"' },
		),
	};
}

async function secureEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);

	const a = new Uint8Array(leftHash);
	const b = new Uint8Array(rightHash);
	let difference = 0;

	for (let index = 0; index < a.length; index += 1) {
		difference |= a[index] ^ b[index];
	}

	return difference === 0 && left.length > 0 && right.length > 0;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}

	const record = value as JsonRecord;
	const keys = Object.keys(record).sort();
	return `{${keys
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableStringify(record[key])}`,
		)
		.join(",")}}`;
}

function jsonResponse(
	body: unknown,
	status: number,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...SECURITY_HEADERS,
			...extraHeaders,
		},
	});
}

function errorResponse(
	status: number,
	code: string,
	message: string,
	requestId: string,
	extraHeaders: Record<string, string> = {},
): Response {
	return jsonResponse(
		{
			status: code,
			message,
			request_id: requestId,
		},
		status,
		extraHeaders,
	);
}

function asRecord(value: unknown): JsonRecord | null {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asArray(value: unknown): unknown[] | null {
	return Array.isArray(value) ? value : null;
}

function getValue(
	record: JsonRecord | null | undefined,
	keys: string[],
): unknown {
	if (!record) return undefined;
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(record, key)) {
			return record[key];
		}
	}
	return undefined;
}

function getString(
	record: JsonRecord | null | undefined,
	keys: string[],
): string | null {
	const value = getValue(record, keys);
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return null;
}

function getNumber(
	record: JsonRecord | null | undefined,
	keys: string[],
): number | null {
	const value = getValue(record, keys);
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function getBoolean(
	record: JsonRecord | null | undefined,
	keys: string[],
): boolean | null {
	const value = getValue(record, keys);
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "sim"].includes(normalized)) return true;
		if (["false", "0", "no", "nao", "não"].includes(normalized)) {
			return false;
		}
	}
	return null;
}

function jsonStringOrNull(value: unknown): string | null {
	return value === undefined || value === null
		? null
		: JSON.stringify(value);
}

function safeJsonParse(value: unknown): unknown {
	if (typeof value !== "string") return value ?? null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function resultRows(result: D1Result<unknown>): JsonRecord[] {
	return Array.isArray(result.results)
		? (result.results as JsonRecord[])
		: [];
}

function firstRow(result: D1Result<unknown>): JsonRecord | null {
	return resultRows(result)[0] ?? null;
}

function isClosedStatus(status: string | null): boolean {
	if (!status) return false;
	const normalized = status
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.trim();

	return [
		"fechado",
		"encerrado",
		"concluido",
		"cancelado",
		"closed",
		"completed",
		"cancelled",
	].includes(normalized);
}

function formatHours(minutes: number): string {
	const safeMinutes = Math.max(0, Math.trunc(minutes));
	const hours = Math.floor(safeMinutes / 60);
	const remainder = safeMinutes % 60;
	return `${hours}h${String(remainder).padStart(2, "0")}`;
}
