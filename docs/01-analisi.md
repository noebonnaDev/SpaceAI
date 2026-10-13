# 01 — Analisi dell'offerta pubblica di SpacEye®

> Documento della fase A. Data dell'analisi: 13/10/2026.
> SpacEye® è un marchio registrato di VEM Sistemi S.p.A. Il nome compare **solo** in questo documento di analisi; il prodotto che progettiamo ha un nome proprio (vedi §7) e non riprende nomi, loghi, colori, testi, schermate, layout o codice di SpacEye.

## 1. Scopo e metodo

Obiettivo: ricavare un inventario **verificato** delle funzionalità pubbliche di SpacEye, da usare come requisito funzionale per uno strumento originale, self-hosted e integrato con Outlook/Microsoft 365.

Regole seguite:

- Solo pagine pubbliche: niente login, niente decompilazione delle app, niente raccolta di dati oltre le pagine pubbliche.
- Ogni funzionalità ha una fonte (pagina di spaceye.cloud o scheda ufficiale degli store) e uno **stato**:
  - **confermato**: la pagina indicata lo afferma esplicitamente;
  - **dedotto**: non è scritto, ma lo si ricava da ciò che è scritto (la motivazione è indicata);
  - **non verificato**: compare nell'inventario preliminare fornito dall'utente (pagina `https://spaceye.cloud/room-page/`, recuperata dall'utente il 13/10/2026), ma non ho potuto verificarlo in modo indipendente. Non lo tratto come falso: lo tratto come requisito plausibile da confermare.

### 1.1 Limite importante sull'accesso alle fonti

L'ambiente cloud in cui lavoro ha una policy di rete che **blocca** l'accesso diretto a `spaceye.cloud`, `apps.apple.com`, `play.google.com` e `learn.microsoft.com` (risposta 403 dal proxy di uscita, verificata il 13/10/2026). Di conseguenza:

- il contenuto delle pagine di spaceye.cloud e delle schede degli store è stato letto **tramite l'indice del motore di ricerca** (testo indicizzato di ciascun URL, con ricerche limitate al dominio `spaceye.cloud` e ai domini degli store). Le date di indicizzazione riportate dal motore indicano che alcune pagine sono state indicizzate tra 8 e 17 mesi fa; la privacy policy dell'app risulta molto più vecchia (circa 1.763 giorni);
- la pagina `https://spaceye.cloud/room-page/` **non risulta nell'indice** che ho potuto interrogare: per questo le voci del modulo Room che provengono solo da quella pagina sono marcate "non verificato";
- per le verifiche Microsoft ho usato i repository GitHub pubblici da cui Microsoft Learn viene pubblicato (vedi `02-progetto.md`, §11).

**Raccomandazione:** dopo aver abilitato questi domini nella configurazione di rete dell'ambiente, ripetere una lettura diretta delle pagine per passare a "confermato" le voci oggi "non verificato".

## 2. Fonti consultate

| # | URL | Tipo | Modalità di accesso |
|---|-----|------|---------------------|
| F1 | https://spaceye.cloud/en/ | Homepage (EN), menu moduli | testo indicizzato |
| F2 | https://spaceye.cloud/en/home/ | Homepage con testo IT/EN, moduli, pannello di amministrazione, Business Card | testo indicizzato |
| F3 | https://spaceye.cloud/en/desk-page/ | Pagina del modulo Desk | testo indicizzato |
| F4 | https://spaceye.cloud/en/spaceye-app-privacy-policy/ | Privacy policy dell'app | testo indicizzato |
| F5 | https://spaceye.cloud/room-page/ | Pagina del modulo Room | **non accessibile né indicizzata**; contenuto noto solo dall'inventario preliminare dell'utente |
| F6 | https://apps.apple.com/it/app/spaceye/id1571277913 | Scheda App Store "Spaceye" | testo indicizzato |
| F7 | https://play.google.com/store/apps/details?id=it.mydev.spaceye | Scheda Google Play "Spaceye" | testo indicizzato |
| F8 | https://play.google.com/store/apps/details?id=it.myDev.myMeetingRoom.AppMobile | Scheda Google Play "SpacEye Room" | testo indicizzato |
| F9 | https://play.google.com/store/apps/details?id=it.mydev.myres.desks.mobile | Scheda Google Play "SpacEye Desk" | testo indicizzato |

Fonti secondarie (articoli di stampa: lineaedp.it, datamanager.it, bitmat.it, tomshw.it, channeltech.it) **non** sono usate per attribuire lo stato "confermato": sono citate solo come indizio dove utile.

## 3. Inventario funzionale verificato

### 3.1 Piattaforma e pannello di amministrazione

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| P-01 | Suite modulare: Room, Desk, BookMe, Monitoring, Care | F1 (menu) | confermato | F2 descrive anche il modulo Vehicle (vedi V-01) |
| P-02 | Pannello di amministrazione unico per configurare tutte le risorse e gli asset prenotabili | F2 | confermato | |
| P-03 | Regole di prenotazione configurabili dall'amministratore | F2, F3 | confermato | F3: regole per gestire prenotazioni anticipate o prolungate e prevenire comportamenti non conformi alla policy aziendale |
| P-04 | Limiti al numero di persone per spazio | F2 | confermato | |
| P-05 | Regole di controllo delle presenze negli spazi | F2 (testo IT) | confermato | |
| P-06 | Monitoraggio degli spazi in tempo reale, gestione di criticità e allarmi | F2 | confermato | |
| P-07 | Dashboard in tempo reale, report dettagliati e KPI sull'uso degli spazi | F2 | confermato | |
| P-08 | KPI "anti-affollamento" (persone presenti, densità) | F2 | confermato | legati al modulo Monitoring |

### 3.2 Room — sale riunioni

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| R-01 | Prenotazione delle sale riunioni più rapida ed efficiente | F2 | confermato | |
| R-02 | Check-in per confermare la prenotazione di una sala (anche di prossimità, via app) | F4 | confermato | F4: "se l'utente è vicino a una postazione/sala prenotata, la prenotazione viene confermata automaticamente" |
| R-03 | Liberazione delle sale non utilizzate (senza check-in) | F4 + F5 | dedotto | Se la prenotazione va "confermata" con il check-in, una prenotazione non confermata viene liberata; il rilascio è anche nell'inventario preliminare (F5) |
| R-04 | Integrazione nativa con MS Exchange, Office 365 e G Suite | F5 | non verificato | Citata anche da stampa (lineaedp.it), non da fonte ufficiale accessibile |
| R-05 | Filtri di ricerca avanzati | F5 | non verificato | |
| R-06 | Check-out per liberare la sala | F5 | non verificato | Il check-out è confermato per Desk (D-03) |
| R-07 | Prenotazione "per conto di" (reception/segreteria) | F5 | non verificato | |
| R-08 | Agenda impegni personale | F5; F7 | dedotto | F7: "con un'unica piattaforma è possibile pianificare e gestire gli impegni" |
| R-09 | NFC/QR code vicino alla sala per prenotare e vedere il calendario | F5 | non verificato | NFC/QR confermati per il check-in Desk (D-04) |
| R-10 | Proposte di prenotazione: più opzioni bloccate, rilascio automatico delle alternative dopo la scelta | F5 | non verificato | |
| R-11 | Prenotazioni ricorrenti | F5 | non verificato | |
| R-12 | Integrazione con sistemi di collaborazione | F5 | non verificato | Non è specificato quali sistemi |
| R-13 | Canali: pannello fuori-porta, app mobile e web desktop, client di posta, totem | F5 | non verificato | La stampa cita un'app per display fuori-porta personalizzabile |
| R-14 | Sincronizzazione con dispositivi di digital signage | F5 | non verificato | |
| R-15 | Integrazione con controllo accessi e building automation (NFC, protocolli di campo) | F5 | non verificato | |

### 3.3 Desk — postazioni

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| D-01 | Planimetrie interattive per trovare e prenotare una postazione e orientarsi | F3 | confermato | |
| D-02 | Prenotazione su più giorni | F3 | confermato | |
| D-03 | Check-in e check-out, anche da remoto | F3 | confermato | |
| D-04 | Check-in in presenza con tag NFC, QR code e beacon BLE | F3 | confermato | |
| D-05 | Postazioni preferite | F3 | confermato | |
| D-06 | "Trova un collega": vedere se un collega ha prenotato e le postazioni libere vicine | F3 | confermato | Dato personale: va gestito con attenzione (vedi GDPR in `02-progetto.md`) |
| D-07 | Check-in di prossimità automatico (posizione/Bluetooth, con consenso revocabile) | F4 | confermato | Richiede app nativa e consenso |

### 3.4 BookMe, Vehicle, Care

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| B-01 | Prenotazione e gestione degli asset aziendali condivisi | F2 | confermato | Nessun dettaglio pubblico su tipi di asset o flussi |
| V-01 | Prenotazione delle auto aziendali, inclusa consegna e restituzione delle chiavi | F2 (testo IT) | confermato | Non presente nell'inventario preliminare; nessun dettaglio su come avviene la consegna chiavi |
| C-01 | Gestione delle richieste aziendali "con un click" | F2 | confermato | Nessun dettaglio su categorie, flussi o SLA |

### 3.5 Monitoring

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| M-01 | Fonti dati: sensori video e telecamere delle postazioni Cisco TelePresence, con analisi video e correlazione | F2 | confermato | |
| M-02 | Conteggio persone in tempo reale, densità, attraversamento di una linea | F2 | confermato | |
| M-03 | Archiviazione di presenza/occupazione per report e grafici storici | F2 | confermato | |
| M-04 | Allarmi in tempo reale | F2 | confermato | |
| M-05 | Modellazione degli spazi (m², persone massime, densità massima) | F2 + F5 | dedotto | Il limite di persone per spazio è confermato (P-04); m² e densità massima vengono da F5 |
| M-06 | Configurazione delle sorgenti dati | F5 | non verificato | |
| M-07 | Pilotaggio di dispositivi di feedback | F5 | non verificato | |
| M-08 | Dati anonimi | F5 | non verificato | |

### 3.6 Biglietto da visita digitale

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| BC-01 | Profilo professionale dinamico raggiungibile tramite QR code univoco | F2 | confermato | |
| BC-02 | Dati sincronizzati automaticamente dall'identity provider aziendale | F2 | confermato | |
| BC-03 | Uso per eventi, fiere, onboarding, networking | F2 | confermato | |
| BC-04 | Campi: nome, ruolo, business unit, contatti, campi configurabili dall'amministratore | F2 + preliminare | non verificato | Il dettaglio dei campi non compare nel testo indicizzato |

### 3.7 App mobili

| ID | Funzionalità | Fonte | Stato | Note |
|----|--------------|-------|-------|------|
| A-01 | App iOS "Spaceye" per prenotare risorse condivise | F6 | confermato | |
| A-02 | App Android "Spaceye" | F7 | confermato | |
| A-03 | App separate "SpacEye Room" (sale) e "SpacEye Desk" (postazioni) | F8, F9 | confermato | F8 risulta aggiornata l'ultima volta il 02/03/2021: probabilmente sostituita dall'app unica (dedotto) |
| A-04 | L'app tratta email, username e azienda dell'utente; posizione e Bluetooth solo con consenso per il check-in di prossimità | F4 | confermato | Utile come riferimento per la nostra informativa GDPR |

## 4. Cosa il sito pubblico non rivela

- **Prezzi e modello di licenza**: nessun prezzo sulle pagine ufficiali consultate (la stampa cita canone annuale e installazione on-premise: non verificato su fonte ufficiale).
- **Architettura tecnica**: non è indicato quale interfaccia Microsoft venga usata per l'integrazione con Exchange/Office 365 (EWS o Microsoft Graph), né come avvenga il single sign-on.
- **Add-in Outlook**: il "client di posta" come canale (R-13) non è descritto; non è chiaro se esista un add-in Office.js.
- **Gestione dei dati personali**: nessun dettaglio su tempi di conservazione, aggregazione, ruoli di accesso ai dati di presenza, posizione dei data center (la privacy policy cita solo possibili trasferimenti extra-UE con garanzie GDPR).
- **Dettagli operativi**: periodo di tolleranza del check-in, regole di rilascio, ruoli e permessi, formati di esportazione dei report, API per integrazioni di terzi, hardware supportato per pannelli e totem, protocolli per controllo accessi.
- **Accessibilità e lingue**: il sito è in italiano e inglese; non ci sono informazioni sulle lingue dell'interfaccia del prodotto o sull'accessibilità.

## 5. Interpretazione per il nostro progetto

- Le funzionalità **confermate** di Room, Desk, BookMe, Care e del pannello di amministrazione diventano requisiti MVP (vedi la tabella di tracciabilità in `02-progetto.md`).
- Le voci **non verificate** del modulo Room (R-04…R-15) sono comunque state richieste esplicitamente nel mandato (check-in con rilascio automatico, QR, pannello fuori-porta, "per conto di", ricorrenze, proposte): le implementiamo nell'MVP come requisiti del cliente, non come "copia" di funzionalità accertate.
- **Monitoring** (sensori/telecamere) e **biglietto da visita digitale** sono progettati per la fase 2; l'interfaccia per i sensori accetta solo conteggi (mai video).
- **Vehicle** (V-01) è coperto funzionalmente come "risorsa condivisa" di BookMe (es. auto aziendale come risorsa prenotabile); la consegna chiavi resta fuori dall'MVP.
- **Check-in di prossimità via Bluetooth/posizione** (D-07) richiede app native: con la PWA lo sostituiamo con QR code/NFC che aprono lo stesso URL.

## 6. Nota di originalità

Questo documento descrive *funzionalità*, non espressione. Il prodotto progettato:

- non usa il nome SpacEye né nomi dei suoi moduli come nomi di prodotto;
- non usa loghi, colori, icone, schermate, testi di marketing, layout o codice di SpacEye;
- implementa le funzionalità in modo indipendente su Microsoft 365 (add-in Office.js + Microsoft Graph).

## 7. Nome del prodotto

- **Nome di lavoro: Ritrovo** — "luogo d'incontro": richiama sale, postazioni e persone senza riferimenti a prodotti esistenti.
- Alternative: **Agorà Spazi**, **Planimetro**.

Nessuna ricerca di anteriorità sui marchi è stata svolta: prima di un uso commerciale va verificata la disponibilità del nome.
