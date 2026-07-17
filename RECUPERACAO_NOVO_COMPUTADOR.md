# OPERA Sync Gateway — recuperação em novo computador

Diretório previsto:

`C:\Users\rcuriel\Desktop\temp\claudflare`

## Preparação

1. Instale Node.js 22 LTS ou versão compatível com Wrangler 4.
2. Extraia o conteúdo deste pacote diretamente no diretório acima.
3. Abra o Prompt de Comando nesse diretório.

## Instalação e autenticação

```bat
cd /d "C:\Users\rcuriel\Desktop\temp\claudflare"
npm install
npx wrangler login --use-keyring
npx wrangler whoami
```

Use a mesma conta Cloudflare que contém o Worker `opera-sync-gateway` e o D1 `opera-canonical-db`.

## Validação do projeto

```bat
npx wrangler types
npx tsc --noEmit
npx wrangler secret list
npx wrangler d1 list
```

Os secrets remotos não precisam ser copiados do computador anterior. Eles permanecem vinculados ao Worker na Cloudflare.

## Teste do Worker já implantado

```bat
curl.exe -i "https://opera-sync-gateway.starlink-rescuer.workers.dev/v1/health"
curl.exe -i "https://opera-sync-gateway.starlink-rescuer.workers.dev/v1/state"
```

Resultados esperados: `200 OK` no health e `401 Unauthorized` no state sem token.

## Desenvolvimento local opcional

Crie `.dev.vars` copiando `.dev.vars.example` e use apenas tokens locais fictícios. Nunca grave tokens de produção nesse arquivo.

```bat
copy .dev.vars.example .dev.vars
npx wrangler dev
```

O D1 local é separado do D1 remoto. Não reaplique a migração remota: ela já foi executada.
