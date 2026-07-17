-- OPERA Sync Gateway
-- Initial canonical D1 schema
-- Migration: 0001_initial_schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS opera_events (
    event_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    opera_version TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'start',
            'refresh',
            'ticket_activity_end',
            'daily_end'
        )
    ),
    generated_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'processed' CHECK (
        processing_status IN ('processed', 'rejected')
    ),
    request_id TEXT,
    source TEXT NOT NULL DEFAULT 'opera_mcp'
);

CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result_status TEXT NOT NULL CHECK (
        result_status IN ('created', 'duplicate', 'rejected')
    ),
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
    ticket_code TEXT PRIMARY KEY,
    title TEXT,
    display_summary TEXT,
    formal_status TEXT,
    analytical_classification TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    opened_at TEXT,
    due_at TEXT,
    closed_at TEXT,
    current_revision INTEGER NOT NULL DEFAULT 0,
    first_seen_event_id TEXT NOT NULL,
    last_seen_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (first_seen_event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE,
    FOREIGN KEY (last_seen_event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_revisions (
    revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_code TEXT NOT NULL,
    event_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    formal_status TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    title TEXT,
    original_request TEXT,
    relevant_evolution TEXT,
    relevant_decisions_json TEXT,
    last_real_advance TEXT,
    current_situation TEXT,
    dependencies_json TEXT,
    pending_items_json TEXT,
    next_step TEXT,
    natural_summary TEXT,
    complexity TEXT,
    remaining_effort_min INTEGER CHECK (
        remaining_effort_min IS NULL OR remaining_effort_min >= 0
    ),
    remaining_effort_max INTEGER CHECK (
        remaining_effort_max IS NULL OR remaining_effort_max >= 0
    ),
    estimate_confidence TEXT,
    uncertainties_json TEXT,
    source_payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_code) REFERENCES tickets(ticket_code)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (ticket_code, revision_number)
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    ticket_code TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    pause_minutes INTEGER NOT NULL DEFAULT 0 CHECK (pause_minutes >= 0),
    gross_minutes INTEGER CHECK (gross_minutes IS NULL OR gross_minutes >= 0),
    net_minutes INTEGER CHECK (net_minutes IS NULL OR net_minutes >= 0),
    pointed_minutes INTEGER CHECK (pointed_minutes IS NULL OR pointed_minutes >= 0),
    session_status TEXT NOT NULL CHECK (
        session_status IN (
            'active',
            'paused',
            'ended',
            'abandoned',
            'pending'
        )
    ),
    report_text TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (ticket_code) REFERENCES tickets(ticket_code)
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS work_logs (
    work_log_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    session_id TEXT,
    ticket_code TEXT NOT NULL,
    work_date TEXT NOT NULL,
    service_text TEXT NOT NULL,
    activity_text TEXT NOT NULL,
    minutes INTEGER NOT NULL CHECK (minutes >= 0),
    source TEXT NOT NULL DEFAULT 'opera',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    FOREIGN KEY (ticket_code) REFERENCES tickets(ticket_code)
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS planning_versions (
    planning_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
    planning_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    horizon_start TEXT,
    horizon_end TEXT,
    generated_at TEXT NOT NULL,
    expires_at TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (planning_id, version_number)
);

CREATE TABLE IF NOT EXISTS calendar_blocks (
    block_id TEXT PRIMARY KEY,
    planning_version_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    ticket_code TEXT,
    block_type TEXT NOT NULL CHECK (
        block_type IN (
            'planned',
            'projected',
            'realized',
            'reserve',
            'meeting',
            'break'
        )
    ),
    block_status TEXT NOT NULL DEFAULT 'active' CHECK (
        block_status IN ('active', 'expired', 'cancelled', 'completed')
    ),
    title TEXT NOT NULL,
    details TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'opera',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (planning_version_id)
        REFERENCES planning_versions(planning_version_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (ticket_code) REFERENCES tickets(ticket_code)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS tombstones (
    tombstone_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    ticket_code TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'fechado_detectado_por_ausencia'
        CHECK (state = 'fechado_detectado_por_ausencia'),
    source_snapshot_complete INTEGER NOT NULL DEFAULT 1
        CHECK (source_snapshot_complete IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (ticket_code) REFERENCES tickets(ticket_code)
        ON UPDATE CASCADE,
    UNIQUE (event_id, ticket_code)
);

CREATE TABLE IF NOT EXISTS daily_closings (
    closing_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    closing_date TEXT NOT NULL,
    work_log_count INTEGER NOT NULL DEFAULT 0 CHECK (work_log_count >= 0),
    total_minutes INTEGER NOT NULL DEFAULT 0 CHECK (total_minutes >= 0),
    total_hours_text TEXT NOT NULL,
    target_minutes INTEGER,
    target_reached INTEGER CHECK (
        target_reached IS NULL OR target_reached IN (0, 1)
    ),
    continuity_summary TEXT,
    persona_mutated INTEGER NOT NULL DEFAULT 0 CHECK (persona_mutated IN (0, 1)),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES opera_events(event_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gateway_state (
    state_key TEXT PRIMARY KEY,
    state_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_opera_events_type_generated
    ON opera_events(event_type, generated_at);

CREATE INDEX IF NOT EXISTS idx_opera_events_received
    ON opera_events(received_at);

CREATE INDEX IF NOT EXISTS idx_tickets_active_code
    ON tickets(active, ticket_code);

CREATE INDEX IF NOT EXISTS idx_tickets_last_seen
    ON tickets(last_seen_event_id);

CREATE INDEX IF NOT EXISTS idx_ticket_revisions_ticket_created
    ON ticket_revisions(ticket_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_revisions_event
    ON ticket_revisions(event_id);

CREATE INDEX IF NOT EXISTS idx_sessions_ticket_started
    ON sessions(ticket_code, started_at);

CREATE INDEX IF NOT EXISTS idx_sessions_event
    ON sessions(event_id);

CREATE INDEX IF NOT EXISTS idx_work_logs_date
    ON work_logs(work_date);

CREATE INDEX IF NOT EXISTS idx_work_logs_ticket_date
    ON work_logs(ticket_code, work_date);

CREATE INDEX IF NOT EXISTS idx_work_logs_event
    ON work_logs(event_id);

CREATE INDEX IF NOT EXISTS idx_planning_versions_event
    ON planning_versions(event_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_planning_current
    ON planning_versions(planning_id)
    WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_calendar_blocks_period
    ON calendar_blocks(starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_calendar_blocks_ticket_period
    ON calendar_blocks(ticket_code, starts_at);

CREATE INDEX IF NOT EXISTS idx_calendar_blocks_planning
    ON calendar_blocks(planning_version_id);

CREATE INDEX IF NOT EXISTS idx_tombstones_ticket_detected
    ON tombstones(ticket_code, detected_at);

CREATE INDEX IF NOT EXISTS idx_daily_closings_date
    ON daily_closings(closing_date);

INSERT OR IGNORE INTO gateway_state (state_key, state_value)
VALUES
    ('schema_version', '1.0.0'),
    ('gateway_status', 'initialized');
