# Cartella dei segreti (non versionata)

Metti qui, **solo sul server**, i file che non devono finire nel repository:

- `ritrovo-app.crt` e `ritrovo-app.key`: certificato del client riservato registrato in Entra ID
  (in `.env`: `ENTRA_CLIENT_CERT_PATH=/run/secrets/ritrovo/ritrovo-app.crt`, `ENTRA_CLIENT_KEY_PATH=/run/secrets/ritrovo/ritrovo-app.key`);
- `ritrovo.crt` e `ritrovo.key`: certificato HTTPS aziendale, se non usi Let's Encrypt (vedi `deploy/Caddyfile`).

I file `*.crt`, `*.key` e `*.pem` sono esclusi da Git (`.gitignore`).
