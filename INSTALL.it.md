# Guida all'installazione (dsh-prime-memory)

Questo plugin è distribuito come **bundle ufficiale DSH**: dopo l'installazione, il livello `dsh.bundle` di `cordis.patch.yml` monta automaticamente la voce del plugin — non serve modificare a mano alcun profilo.

## Requisiti

- Node.js ≥ 22.16 (DSH 0.2.0-rc.1 o superiore)
- DeepSeek Harness (di seguito DSH) installato, con `--profile web` disponibile

## Installazione

Scegli liberamente uno dei modi di invocazione seguenti (il prefisso `npx` può sostituire `dsh` in qualsiasi comando qui sotto):

```bash
# Modo 1: eseguire la CLI ufficiale direttamente con npx (niente dsh preinstallato; la versione può essere fissata, es. dsh-prime-memory@0.8.4)
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# Modo 2: con la CLI dsh già installata (dsh è un inoltratore pnpm; se pnpm manca, prima npm i -g pnpm)
dsh plugin --profile web add dsh-prime-memory

# Sorgenti alternative del pacchetto: repository GitHub / percorso locale (sviluppo/debug; link: punta al repository, bastano npm run build + riavvio di dsh)
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Far installare dall'agente (consigliato)

Invia tale e quale il messaggio seguente all'agente attuale (purché possa eseguire comandi da terminale):

```text
Installa il plugin dsh-prime-memory per il profilo web di DeepSeek Harness.

Esegui solo i due comandi seguenti e non modificare altri profili:
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

Quando dsh-prime-memory compare nell'output, comunicami l'esito dell'installazione.
Non chiudere o riavviare di tua iniziativa il DSH in esecuzione; a installazione completata, ricordami di riavviare manualmente il DSH Web Host.
```

## Aggiornamento

```bash
# Aggiornare all'ultima versione
dsh plugin --profile web update dsh-prime-memory

# Aggiornare a una versione specifica
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

L'aggiornamento sostituisce solo il codice del plugin e gli artefatti in `dist/`; la directory dei dati `~/.dsh/memory/` non viene toccata.

## Verifica

Dopo l'installazione e il riavvio del DSH Web Host, controlla:

1. **Compare la directory dei dati** — il plugin è stato applicato con successo: sotto `~/.dsh/memory/` compaiono le directory `conversations/`, `records/`, `scenes/` e il file `memory.db`;
2. **La pagina «Memoria» compare nelle impostazioni** e il pill di modalità compare nella barra di input — la metà client è pronta;
3. Invia un messaggio con informazioni personali, attendi la fine della distillazione e poi chiedine conto in un altro turno di conversazione: nel contesto dovrebbe comparire la riga «Iniezione di contesto · memory».

Smoke test opzionale (sviluppo/diagnostica):

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## Migrazione / downgrade

- **Migrazione dalla vecchia versione (chiamata `dsh-memory-plugin` prima del 0.5.0)**: la vecchia directory dei dati è incompatibile col nuovo pacchetto; fai un backup e poi elimina `~/.dsh/memory/`, verrà ricostruita al primo avvio del nuovo plugin. Le memorie esistenti non possono essere aggiornate direttamente: serve una nuova distillazione.
- **Tornare alla vecchia versione**: dopo `dsh plugin --profile web remove dsh-prime-memory` reinstalla seguendo la documentazione della vecchia versione; la directory dei dati resta, ma la vecchia versione non riconosce la nuova struttura — si consiglia di ripulirla.

## Disinstallazione

```bash
dsh plugin --profile web remove dsh-prime-memory
```

I dati restano in `~/.dsh/memory/`; se non servono più, elimina a mano l'intera directory.

## Risoluzione dei problemi

| Sintomo | Causa probabile | Rimedio |
| --- | --- | --- |
| Dopo l'installazione manca la pagina «Memoria» nelle impostazioni | DSH non riavviato / bundle non montato | Riavvia il DSH Web Host; verifica con `dsh --profile web --dump-config` che ci sia `dsh-prime-memory` |
| `duplicate loader entry id` al riavvio | un `insert:` aggiunto a mano convive con la voce bundle di pari id | Elimina la voce `insert:` aggiunta manualmente; il pacchetto include già il suo livello bundle |
| Nessuna riga «Iniezione di contesto · memory» | distillazione non eseguita / richiamo disattivato | Verifica che la modalità non sia off e che `recall.enabled=true`; cerca `L1 阶段完成` in `memory.log` |
| Download del modello di embedding locale bloccato | mirror non raggiungibile in connessione diretta | Imposta `embedding.proxy` per passare da un proxy; oppure sostituisci `embedding.mirror` con l'ufficiale `huggingface.co` |
| Errore 401 dall'embedding remoto | apiKey errata / servizio senza chiave a cui non va inviata | Controlla `embedding.apiKey`; per un servizio self-hosted senza chiave lascia apiKey vuota |

Per approfondire, vedi [README.md](./README.md) e [CHANGELOG.md](./CHANGELOG.md).
