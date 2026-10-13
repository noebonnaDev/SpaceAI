# Ritrovo

Prenotazione di **sale riunioni**, **postazioni** e **risorse condivise**, integrata con **Outlook / Exchange Online** tramite Microsoft Graph.

- Web app installabile (PWA), in italiano e predisposta per altre lingue.
- Add-in per Outlook (Windows, Mac, web e mobile).
- Check-in con app, QR code, NFC o pannello fuori-porta; rilascio automatico delle sale non usate.
- Pannello di amministrazione con report KPI ed esportazione CSV.

Outlook/Exchange resta la fonte di verità per i calendari. Ritrovo gestisce regole, check-in, postazioni, planimetrie e statistiche.

## Prova in un minuto (modalità demo)

Serve Docker con Compose v2.

```bash
docker compose up
```

Apri **http://localhost:8080** e scegli un utente di esempio: *Giulia Rinaldi* (amministratrice), *Paolo Ferri* (reception) o un dipendente. In demo i calendari Exchange sono **simulati** e i dati sono di esempio: nessuna email parte, nessun tenant viene toccato.

Per fermare la demo e cancellarne i dati: `docker compose down -v`.

### Demo senza server, nel browser

`npm run build:demo` produce in `packages/demo/dist` un sito statico che esegue l'intera Ritrovo nel browser: il codice del server, PostgreSQL in WebAssembly (PGlite) ed Exchange simulato, con gli stessi dati di esempio. Si pubblica su qualsiasi hosting statico (i file `.wasm` vanno serviti come `application/wasm`) e serve a far provare l'app a colleghi o clienti senza installare nulla. I dati vivono solo nella scheda del browser: ricaricando la pagina si riparte da zero. Una barra "Demo" permette di passare al pannello di una sala, allo schermo dell'ingresso e di simulare la scansione di un QR code.

## Documentazione

| Documento | Contenuto |
|-----------|-----------|
| [docs/01-analisi.md](docs/01-analisi.md) | analisi funzionale del prodotto di riferimento, con fonti |
| [docs/02-progetto.md](docs/02-progetto.md) | architettura, modello dati, permessi Microsoft Graph, sincronizzazione, sicurezza e GDPR, tracciabilità |
| [docs/03-installazione.md](docs/03-installazione.md) | **installazione in produzione** passo passo: Entra ID, caselle delle sale, permessi Exchange, server, add-in, backup |
| [docs/04-uso.md](docs/04-uso.md) | guida per dipendenti, reception e amministratori; definizioni dei KPI; bozza di informativa privacy |

## Produzione (in breve)

1. Esegui i passi nel tenant Microsoft 365 descritti in `docs/03-installazione.md` (registrazione dell'app, consenso, caselle delle sale, RBAC di Exchange).
2. `cp .env.example .env` e compila i valori: ogni riga indica da dove si ricava.
3. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` (HTTPS con Caddy).
4. Distribuisci l'add-in da Microsoft 365 admin center con l'URL `https://<host>/addin/manifest.xml`.

Nessun segreto è salvato nel repository: `.env`, certificati e chiavi sono esclusi da Git.

## Sviluppo

Richiede Node.js 22.

```bash
npm ci
npm run typecheck
npm test                    # unit e integrazione: server, web, add-in
npm run test:acceptance     # gli 11 test di accettazione (Graph in modalità mock)
npm run build
npm run manifest -- --url https://<host>        # genera packages/addin/build/manifest.xml
npm run manifest:validate
```

I test usano un PostgreSQL in memoria (PGlite). Per usarne uno reale: `TEST_DATABASE_URL=postgres://utente:password@host:5432/db npm run test:acceptance`.

Avvio in sviluppo (database in memoria, dati di esempio, Exchange simulato):

```bash
SEED_DEMO_DATA=true npm run dev          # API su http://localhost:8080
npm run dev -w @ritrovo/web              # interfaccia su http://localhost:5173
```

### Struttura

```
packages/shared   tipi condivisi tra server e interfaccia
packages/server   API (Fastify), PostgreSQL, gateway Microsoft Graph (reale e mock), job, test
packages/web      PWA, pannello di amministrazione, pannello fuori-porta, totem, pagine dell'add-in
packages/addin    manifest XML dell'add-in Outlook, generatore e validatore
packages/demo     demo statica: app e server nel browser (PGlite, Exchange simulato)
deploy/           Caddyfile (HTTPS)
scripts/          backup e ripristino del database
e2e/              smoke test dell'interfaccia con Playwright
```
