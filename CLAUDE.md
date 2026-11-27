# SlashDeck — CLAUDE.md

> Nome provvisorio. Strumento che rende visibili i comandi di Claude Code che non sono documentati da nessuna parte: comandi di progetto, skill e plugin di team. I comandi integrati fanno da contorno.

## Obiettivo

Digitando `/` Claude Code mostra già i comandi con una descrizione. Il problema vero è un altro: un collega aggiunge una skill o un comando di progetto e nessuno lo viene a sapere, e chi cerca "come faccio X" non sa quale comando usare.

SlashDeck:

1. **Scopre** tutti i comandi disponibili chiedendoli alla CLI di Claude Code installata, e li collega ai file sorgente (comandi custom, skill, plugin).
2. **Mette in evidenza** quelli custom e di team: da dove vengono, quali sono nuovi, cosa dice il team su quando usarli.
3. **Permette di cercare** per intenzione ("voglio fare X") sulle descrizioni, prima ancora che di sfogliare.
4. **Mostra** tutto dove serve: prima come skill dentro Claude Code, poi come vista in VS Code.

Non è un catalogo curato a mano dei comandi integrati: per quelli valgono nome e descrizione forniti dalla CLI.

## Strategia

Si costruisce a tappe, e ogni tappa deve dimostrare che la successiva vale la pena.

1. **Core** con scoperta e CLI `slashdeck` (M1).
2. **Skill di aiuto** che usa il core: nessun codice IDE, funziona uguale in terminale, VS Code e JetBrains (M2). È la prova più economica per capire se ai colleghi serve.
3. **Stato e override di team** (M3), poi **estensione VS Code** (M4) e **plugin JetBrains** per WebStorm (M5). Decisione del 2026-11-27: i plugin IDE si costruiscono subito, senza attendere l'esito della prova della skill con i colleghi.
4. **Rimandati** finché non c'è una richiesta concreta: spiegazioni generate con `claude -p`, suggerimenti contestuali.

## Architettura

Monorepo con un **core condiviso** e front-end sottili. Tutta la logica sta nel core: skill e plugin IDE non duplicano mai logica di scoperta, cache o stato.

```
slashdeck/
├── packages/
│   ├── core/          # Node + TypeScript. Libreria + CLI (`slashdeck`); il build produce anche dist/slashdeck.mjs, la CLI in un singolo file
│   ├── skill/         # SKILL.md + CLI del core in un singolo file (M2)
│   ├── vscode/        # Estensione VS Code (M4), usa core come libreria
│   └── jetbrains/     # Plugin IntelliJ Platform in Kotlin (M5), chiama la CLI del core come processo
├── data/
│   └── builtin-commands.json   # Solo categorie, voci nascoste e voci extra dei builtin
├── docs/
└── CLAUDE.md
```

### Scoperta: la CLI è la fonte principale

Verificato su Claude Code 2.1.318 (Windows) il 2026-11-27. Questa chiamata restituisce l'elenco completo dei comandi **senza inviare alcun prompt** e in circa 2,4 secondi:

```bash
echo '{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config \
      --settings <file con {"disableAllHooks": true}>
```

La risposta è una riga JSON `control_response`. In `response.response` ci sono `claude_code_version` e `commands`, un array di `{ name, description, argumentHint, builtin }`. Nella prova: 81 comandi, 58 con `builtin: true`. Il campo `builtin` è presente solo sui comandi integrati: sugli altri manca del tutto, non vale `false`. Alcuni comandi hanno anche un array `aliases`, per ora ignorato.

Cosa bisogna sapere:

- **Gli hook vanno disattivati.** Senza `disableAllHooks` la chiamata esegue gli hook `SessionStart` dell'utente (verificato con un hook di prova) e aggiunge righe `system` prima della risposta. Con `disableAllHooks: true` gli hook non partono e l'elenco resta completo. Passare il file per percorso, non il JSON in linea: le virgolette sono fragili quando `claude` è uno script `.cmd` su Windows.
- **`--bare` non va usato**: restituisce solo 52 comandi, nessuno custom.
- **L'elenco può variare leggermente** tra due chiamate identiche (nella prova `ultrareview` compare in una e non nell'altra). Un comando sparito per una sola scansione non va trattato come rimosso.
- **L'elenco dipende dalla cartella di lavoro**: la chiamata va fatta con `cwd` uguale al workspace, così include i comandi di progetto.
- **I nomi sono quelli veri**, namespace compreso (`gxrr:wiki`). I nomi non vanno mai ricostruiti a mano: una skill sincronizzata può comparire come `docx` in un contesto e come `anthropic-skills:docx` in un altro.
- **Mancano i comandi solo interattivi** (nella prova: `help`, `permissions`, `resume`, `memory`). Vanno aggiunti a mano come voci extra, dopo averli verificati nel menù `/` interattivo.
- **Compaiono voci interne** (es. `__remote-workflow`, `heapdump`, `workflow-launch-exec`). Vanno nascoste: in automatico i nomi che iniziano con `__`, gli altri tramite l'elenco `hidden` del file dati.
- **La risposta contiene dati dell'account** (`account`, `models`…). Il core legge solo `claude_code_version` e `commands`; il resto non va mai salvato, scritto nei log o copiato nelle fixture dei test.
- **È il protocollo usato dall'Agent SDK**, non un'opzione documentata della CLI. Va isolato in un solo modulo, validato con zod e protetto da timeout. L'equivalente documentato dovrebbe essere `supportedCommands()` dell'Agent SDK (da verificare): è l'alternativa se il formato cambia.
- **Se `claude` manca o la chiamata fallisce** si degrada con grazia alla sola scansione dei file, segnalandolo nell'output.

### Scansione dei file: classificazione e riserva

La CLI dice quali comandi esistono, ma non da dove vengono. La scansione dei file serve ad attribuire a ogni comando non integrato il tipo e il file sorgente, e a fare da riserva quando la CLI non risponde.

Percorsi verificati su Claude Code 2.1.318 (Windows). Ricontrollarli sulla versione installata prima di darli per scontati; se un percorso cambia, aggiornare qui.

- comandi utente: `~/.claude/commands/**/*.md` (la cartella può non esistere);
- comandi di progetto: `<workspace>/.claude/commands/**/*.md`;
- skill utente: `~/.claude/skills/<nome>/SKILL.md`;
- skill sincronizzate dall'account: `~/.claude/skills/synced/<id>/<nome>/SKILL.md`, con un `manifest.json` per gruppo; ignorare le sottocartelle `.staging`;
- skill di progetto: `<workspace>/.claude/skills/<nome>/SKILL.md`;
- plugin installati: il registro è `~/.claude/plugins/installed_plugins.json` (per ogni plugin: `scope`, `installPath`, `version`). Ogni `installPath` punta a `~/.claude/plugins/cache/<marketplace>/<plugin>/<versione>/`, che contiene `.claude-plugin/plugin.json`, `skills/<nome>/SKILL.md` ed eventualmente `commands/*.md`;
- plugin sincronizzati dall'account: `~/.claude/plugins/synced/<gruppo>/<cartella>/.claude-plugin/plugin.json`. Non compaiono in `installed_plugins.json`; il nome del plugin si legge dal manifest.

Regole:

- **Frontmatter**: per i comandi custom `description`, `argument-hint`, ecc.; per le skill `name` e `description`. Nella sola modalità di riserva, escludere le skill con `user-invocable: false`.
- **Abbinamento ai nomi della CLI**: un comando di plugin si abbina a `<plugin>:<nome>`; una skill o un comando si abbinano per nome esatto, oppure per l'ultima parte dopo `:` quando il prefisso non è un plugin installato.
- **Comandi non abbinati**: una voce non integrata che non corrisponde a nessun file resta nel catalogo con `kind: "unknown"` e `sourcePath: null`.
- **Nomi uguali in più sorgenti**: vince il primo in quest'ordine: skill utente, skill di progetto, comandi utente, comandi di progetto, skill sincronizzate. È un'ipotesi del core, non verificata su Claude Code (vedi Domande aperte).
- **Non coperti dalla scansione dei file**: i prompt MCP (`/mcp__<server>__<prompt>`). Compaiono solo se li restituisce la CLI.

### packages/core

Moduli principali:

- `discovery/cli-source` — la chiamata `initialize` descritta sopra. Il processo si avvia tramite una funzione iniettabile, così i test non chiamano mai la CLI reale.
- `discovery/file-source` — la scansione dei file. Cartella home e workspace sono parametri, così i test usano fixture.
- `discovery/merge` — unisce le due fonti, applica categorie, voci nascoste e voci extra.
- `cache/` — ultimo risultato di scansione per workspace (M3).
- `state/` — stato utente, override di team, vista risolta (M3).
- `api.ts` — le funzioni che usa l'estensione VS Code: `scanAndCache`, `loadCachedView`, `pinCommand`, `unpinCommand`, `editCommand`, `resetCommand`, `clearCache`.
- `paths.ts` — cartelle di cache e di stato, `workspaceId`.
- `cli.ts` — CLI `slashdeck`. Su stdout solo JSON (o Markdown se richiesto), log e avvisi su stderr. Exit code: 0 se il comando riesce, anche in modalità di riserva; 1 in caso di errore, compreso un file di stato illeggibile; 2 per un uso errato; 3 se non c'è ancora una cache per il workspace; 4 se il comando indicato non è nel catalogo in cache. In caso di errore stdout resta vuoto e il motivo va su stderr. I comandi di scrittura stampano un JSON uniforme: `{ action, command, workspaceId, changed, scope, entry }`. Accetta `--claude-path <path>` (o la variabile `SLASHDECK_CLAUDE_PATH`) per indicare l'eseguibile di Claude Code. Tutti i comandi accettano `--workspace <path>`:
  - `slashdeck scan --json` — catalogo completo (M1)
  - `slashdeck scan --markdown` — lo stesso catalogo in forma leggibile, per la skill (M2). Con `--quiet` gli avvisi non vengono ripetuti su stderr
  - `slashdeck scan --cached` — vista risolta dall'ultima cache, senza chiamare Claude Code (M3)
  - `slashdeck get <command> --json` (M3)
  - `slashdeck pin <command>` / `slashdeck unpin <command>` (M3)
  - `slashdeck edit <command>` — legge da stdin un JSON con i campi da modificare; `slashdeck reset <command>` rimuove le modifiche dell'utente (M3)
  - `slashdeck cache clear` (M3)
  - Le cartelle di cache e di stato si possono spostare con le variabili `SLASHDECK_CACHE_DIR` e `SLASHDECK_CONFIG_DIR` (usate anche dai test)

### packages/skill (M2)

- Una skill che, quando viene invocata, esegue `slashdeck scan --markdown` e fa rispondere Claude a partire da quel catalogo: elenco per gruppo, spiegazione di un comando, "voglio fare X, quale comando uso?".
- Contiene la CLI del core in un singolo file JavaScript (`scripts/slashdeck.mjs`, circa 576 KB), così non richiede installazioni oltre a Node 20 o successivo.
- Il sorgente è `packages/skill/src/SKILL.md`; il build produce la cartella pronta da copiare `packages/skill/dist/slashdeck/`.
- Si distribuisce copiandola in un plugin di team come `skills/help/` (diventa `/<plugin>:help`) o in `.claude/skills/` di una repo. Le istruzioni per i colleghi sono in `packages/skill/README.md`.

Come ottiene il catalogo (verificato su 2.1.318 con una prova reale):

- `SKILL.md` contiene un blocco di codice che inizia con tre backtick seguiti da `!`: Claude Code esegue il comando all'invocazione e ne sostituisce l'output al blocco, prima che il modello legga la skill.
- `${CLAUDE_SKILL_DIR}` e `${CLAUDE_PROJECT_DIR}` vengono sostituiti con percorsi a barre normali, anche su Windows.
- **Il comando va approvato in anticipo nel frontmatter**, altrimenti l'invocazione fallisce con "This command requires approval": `allowed-tools: Read, Bash(node "${CLAUDE_SKILL_DIR}/scripts/slashdeck.mjs" scan *)`. La regola copre solo lo script della skill, non `node` in generale. La documentazione letta dall'agente diceva che il comando non richiede permessi: sulla versione installata non è così.
- La chiamata `initialize` funziona anche dall'interno di una sessione di Claude Code già aperta.
- Costo misurato di un'invocazione in una sessione nuova con Sonnet: circa 0,13 dollari. Il catalogo pesa circa 17.000 caratteri, con le descrizioni tagliate a 240.

### packages/vscode (M4, versione ridotta)

- **Ricerca prima di tutto**: `SlashDeck: Cerca comando` apre una ricerca su nomi e descrizioni. È l'ingresso principale.
- **TreeView** nella Activity Bar: Preferiti in cima, poi Progetto, Plugin, Personali, e in fondo i gruppi dei comandi integrati. Badge "nuovo" sui comandi appena scoperti.
- **Tooltip** (`TreeItem.tooltip` come `MarkdownString`): descrizione, argomenti, origine di ogni testo, file sorgente.
- **Azioni**: Copia (azione primaria), Esegui (solo se disponibile, vedi sotto), Apri file sorgente, Fissa/Togli dai preferiti, Modifica descrizione.
- **Esecuzione**: "Copia" è l'azione primaria e funziona sempre, anche per chi usa il pannello dell'estensione Claude Code e non ha un terminale. "Esegui" compare solo quando viene rilevato un terminale integrato in cui gira `claude`; in quel caso il comando è inviato con `terminal.sendText`. **Non creare mai un terminale nuovo per eseguire un comando**: aprirebbe una sessione nuova, dove i comandi legati alla sessione (`/compact`, `/context`) non hanno senso. Verificare se l'estensione ufficiale di Claude Code espone un modo per inviare comandi al suo pannello; finché non è confermato, non dipenderne.
- **FileSystemWatcher** su `.claude/commands`, `.claude/skills` e cartelle utente per rilevare nuovi comandi.
- Command Palette: `SlashDeck: Cerca comando`, `SlashDeck: Aggiorna elenco`.

Come è stata realizzata (M4):

- **Pacchetto**: nome `slashdeck`, editore provvisorio `slashdeck-placeholder`, VS Code 1.93 o successivo. Un solo file CommonJS (`dist/extension.cjs`) che include il core; nessuna logica di scoperta, cache o stato propria.
- **Clic su un comando**: apre l'elenco delle azioni con "Copia" per prima. Non copia direttamente, per non sovrascrivere gli appunti senza avviso. La ricerca porta allo stesso elenco.
- **Dopo "Copia"**: se non c'è un terminale `claude` e l'estensione ufficiale di Claude Code ha registrato `claude-vscode.focus`, il cursore passa nel suo campo di input e all'utente resta solo da incollare. Si disattiva con `slashdeck.focusClaudeCodeAfterCopy`.
- **Rilevamento del terminale `claude`**: tramite la shell integration di VS Code, che segnala inizio e fine di ogni comando eseguito nel terminale. Un terminale conta come terminale Claude mentre è in corso un comando che avvia `claude` in modo interattivo. I nomi dei terminali non vengono usati: un falso positivo invierebbe `/init` a una shell normale.
  - Funziona con PowerShell, bash, zsh e fish, se `claude` è stato avviato dopo l'attivazione dell'estensione.
  - Non rileva: `cmd.exe`, shell integration disattivata, `claude` avviato prima dell'attivazione (per esempio un terminale ripristinato), alias con un altro nome. In questi casi "Esegui" non compare e resta "Copia".
- **"Esegui" con argomenti**: se il comando ha un suggerimento di argomenti, il testo viene scritto senza Invio e il terminale riceve il focus, così l'utente completa e conferma. Senza argomenti viene inviato subito.
- **Nessuna cartella aperta**: usa la cartella home; compaiono i comandi personali, dei plugin e integrati. **Più cartelle**: usa la prima, o quella scelta con "Seleziona cartella".
- **Workspace non attendibile**: Claude Code non viene avviato; l'elenco viene dai soli file, con un messaggio che lo spiega.
- **Impostazioni**: `slashdeck.claudePath`, `slashdeck.refreshOnStartup`, `slashdeck.focusClaudeCodeAfterCopy`.
- **Cartella utente**: come la CLI del core, rispetta la variabile `CLAUDE_CONFIG_DIR` al posto di `~/.claude`.
- **Errori**: solo nel registro "SlashDeck" e in un messaggio sopra l'albero; nessuna finestra modale.

Aggiornamento automatico (corretto nella 0.1.1 dopo un ciclo infinito di scansioni nella 0.1.0):

- **Il problema**: ogni avvio di `claude`, compreso quello fatto dalla scansione, riscrive file di servizio in `~/.claude/plugins/synced/` (`manifest.json`, `.last-complete-round`, `.in_use/`) e in `~/.claude/skills/synced/` (`.staging/`). Chi osserva quelle cartelle e reagisce a ogni modifica con una scansione entra in un ciclo, che con più finestre si alimenta a vicenda.
- **Regola valida per ogni front-end**: una scansione non deve mai poterne provocare un'altra. Si riscansiona solo se è cambiato davvero un file che definisce un comando.
- **Come lo decide l'estensione**: un'impronta calcolata con la scansione dei file del core (percorso e hash di ogni comando, skill e plugin), che non avvia processi. Dopo un evento su file, la scansione parte solo se l'impronta è cambiata.
- **Filtro alla fonte**: ignorati file e cartelle che iniziano con un punto (tranne `.claude-plugin`), `manifest.json` e gli eventi "cartella modificata".
- **Rete di sicurezza**, indipendente dal resto: almeno 10 secondi tra una scansione e la successiva automatica; richieste ravvicinate raddoppiano l'attesa fino a 300 secondi; alla sesta di fila l'aggiornamento automatico si mette in pausa con un messaggio. "Aggiorna elenco" funziona sempre subito e toglie la pausa.
- **Durante un aggiornamento in background** l'elenco resta visibile e non compare la barra di avanzamento.
- **Verificato con il Claude Code reale** in una copia isolata di VS Code: nessuna scansione in 45 secondi di quiete e dopo tre avvii esterni di `claude`; una sola scansione dopo la creazione di un file di comando, comparso nell'elenco come nuovo.
- **Le prove con una CLI finta non bastano** per ciò che dipende dai file che Claude Code scrive: la CLI finta della prova ora scrive gli stessi file di servizio, e ogni front-end va provato almeno una volta con quella vera prima di essere installato.

### packages/jetbrains (M5)

- Plugin IntelliJ Platform (Kotlin), compatibile con WebStorm, con una ToolWindow equivalente alla vista di VS Code.
- Invoca la CLI del core come processo esterno: nessuna logica duplicata in Kotlin oltre a UI e parsing del JSON.
- Include la CLI come singolo file JavaScript (`slashdeck.mjs`) e la esegue con il Node configurato nell'IDE, altrimenti con `node` dal PATH. Se Node manca, lo dice con un messaggio chiaro.
- Stessa regola di esecuzione di VS Code: "Copia" come azione primaria, "Esegui" solo con un terminale `claude` rilevato.

Come è stato realizzato (M5):

- **Versioni**: Gradle 9.9.2, IntelliJ Platform Gradle Plugin 2.20.1, Kotlin 2.4.21, JDK 21. Compilato su WebStorm 2026.1.5.2; compatibilità dichiarata dalla build 261 alla 263 (WebStorm 2026.1–2026.3). Identificativo ed editore sono provvisori (`slashdeck.placeholder`).
- **Verifica di compatibilità**: il Plugin Verifier di JetBrains su WebStorm 2026.3.0.1 dice "Compatible", con 41 usi di API sperimentali, tutti dell'API del terminale.
- **CLI inclusa**: il build copia `packages/core/dist/slashdeck.mjs` in `<plugin>/cli/` e si ferma con un messaggio chiaro se il file manca. Il plugin chiama `scan --cached`, `scan`, `pin`, `unpin`, `edit`, `reset` e legge solo JSON e codici di uscita.
- **Ricerca di Node**, in quest'ordine: percorso nelle impostazioni (Settings | Tools | SlashDeck), interprete Node configurato nell'IDE (integrazione facoltativa, il plugin si carica anche senza i plugin JavaScript), `node` dal PATH. Serve Node 20 o successivo; se manca, la finestra mostra solo il messaggio con cosa fare.
- **Ordine delle categorie**: arriva dal core nel campo `categoryOrder` della vista risolta; Kotlin non lo ricalcola.
- **Filtro**: ogni parola deve comparire in nome, argomenti, descrizione o "quando usarlo". È più semplice della ricerca di VS Code, che ordina i risultati per pertinenza.
- **"Esegui"**: usa l'API del nuovo terminale (shell integration, sperimentale, dalla 2025.3) come dipendenza facoltativa. Un terminale conta solo se sta eseguendo un comando che avvia `claude` in modo interattivo; i titoli delle schede non vengono usati. Non funziona con il terminale classico, con `cmd.exe` o con la shell integration disattivata: in quei casi "Esegui" non compare.
- **Aggiornamento automatico**: nessuna cartella sotto `~/.claude` viene osservata. Contano solo, nel progetto, i file `.md` in `.claude/commands/`, i `SKILL.md` in `.claude/skills/<nome>/`, le cartelle aggiunte o tolte lì e `.claude/slashdeck.json` (che richiede solo `scan --cached`). Limite rigido: una scansione automatica ogni 60 secondi al massimo; riaprendo la finestra si aggiorna solo se l'elenco ha più di 5 minuti. "Aggiorna" a mano è sempre immediato. Di conseguenza i nuovi comandi personali o dei plugin compaiono al prossimo aggiornamento, non subito.
- **Verificato con il Claude Code reale**: una scansione non crea né modifica file nella cartella `.claude` del progetto (solo la data delle cartelle, che il plugin non considera), quindi non può innescarne un'altra.
- **Mai visto in esecuzione in un IDE**: provato solo con test unitari e in un IDE senza interfaccia.

## Modello dati

Tre file con ruoli distinti. La cache è eliminabile in qualsiasi momento; lo stato utente e l'override di team no.

| File | Percorso | Contenuto | Chi lo scrive |
| --- | --- | --- | --- |
| Cache di workspace | `~/.cache/slashdeck/workspaces/<workspaceId>/catalog.json` (Windows: `%LOCALAPPDATA%\slashdeck\workspaces\<workspaceId>\catalog.json`) | ultimo risultato di scansione per quel workspace | solo il core |
| Stato utente | `~/.config/slashdeck/state.json` (Windows: `%APPDATA%\slashdeck\state.json`) | preferiti e modifiche manuali | solo azioni esplicite dell'utente |
| Override di team | `<workspace>/.claude/slashdeck.json` | descrizioni e indicazioni condivise, versionate nella repo | il team, a mano |

`workspaceId` = primi 16 caratteri esadecimali dello SHA-256 del percorso assoluto normalizzato del workspace. Normalizzato significa: percorso assoluto, barre normali, senza barra finale, in minuscolo solo su Windows. Collegamenti simbolici e nomi brevi di Windows (`GAETAN~1`) non vengono risolti, quindi la stessa cartella raggiunta in due modi diversi può avere due ID.

La cache è una sola per workspace, non più globale più workspace: l'elenco restituito dalla CLI dipende dalla cartella di lavoro e arriva già completo, quindi dividerlo non porta vantaggi. Serve a mostrare subito l'albero all'avvio dell'IDE e a riconoscere i comandi nuovi.

### Catalogo (risultato della scansione)

L'esempio mostra una voce come appare nella vista risolta. Nel catalogo salvato in cache non compaiono mai `guide` né le origini `team` e `user-edit`: arrivano solo in lettura, dall'override di team e dallo stato utente.

```jsonc
{
  "schemaVersion": 1,
  "claudeCodeVersion": "2.1.318",   // null in modalità di riserva
  "source": "cli",                  // cli | files (riserva, quando la CLI non risponde)
  "workspace": "C:/repos/progetto",
  "scannedAt": "2026-11-27T00:00:00Z",
  "warnings": [],                   // voci { "code": "cli-not-found", "message": "..." }
  "commands": {
    "/gxrr:wiki": {
      "name": "/gxrr:wiki",
      "kind": "plugin",             // builtin | custom-user | custom-project | skill-user
                                    // | skill-synced | skill-project | plugin | unknown
      "plugin": "gxrr",             // solo per kind "plugin"
      "sourcePath": "C:/Users/.../skills/wiki/SKILL.md",   // null per builtin e unknown
      "hash": "sha256:...",         // vedi "Hash"
      "category": "plugin:gxrr",    // ID stabile, vedi "Categorie"
      "description": "File a document in the GX-RR architecture wiki...",
      "argumentHint": "",
      "guide": {                    // facoltativa: la scrivono il team o l'utente
        "whenToUse": "...",
        "example": "/gxrr:wiki analysis/nota.md",
        "related": ["/gxrr:doctor"]
      },
      "origins": {                  // una voce per campo presente
        "description": "cli",       // cli | local-metadata | curated | derived | team | user-edit
        "argumentHint": "cli",
        "category": "derived"
      }
    }
  }
}
```

Un campo non disponibile è assente, sia dal valore sia da `origins`.

Origini:

- `cli` — testo restituito dalla CLI di Claude Code;
- `local-metadata` — frontmatter del file sorgente (usato in modalità di riserva);
- `curated` — `data/builtin-commands.json`;
- `derived` — calcolato da SlashDeck a partire da altri dati: la categoria ricavata dal tipo di comando, oppure `other` per un builtin senza categoria curata;
- `team` — override di team;
- `user-edit` — modifica dell'utente.

### Cache (M3)

Il file di cache contiene il catalogo dell'ultima scansione più i dati per il badge "nuovo":

```jsonc
{
  "schemaVersion": 1,
  "firstScanAt": "2026-11-27T00:00:00Z",   // prima scansione di questo workspace
  "catalog": { /* il catalogo, come sopra */ },
  "seen": {                                 // una voce per ogni comando mai visto
    "/gxrr:wiki": { "firstSeenAt": "2026-11-27T00:00:00Z", "lastSeenAt": "2026-11-28T00:00:00Z" }
  }
}
```

- Un comando è **nuovo** se è comparso dopo la prima scansione del workspace (`firstSeenAt` successivo a `firstScanAt`) e da meno di 14 giorni. Alla prima scansione nessun comando è nuovo.
- `seen` non si svuota quando un comando sparisce: l'elenco della CLI può variare tra due chiamate, e un comando che ricompare non deve tornare "nuovo". Le voci non più viste da 30 giorni si eliminano.
- La scrittura è atomica (file temporaneo e rinomina): più finestre dell'IDE possono scrivere lo stesso file.
- Una cache con `schemaVersion` sconosciuta o illeggibile si ignora e si riscrive.
- Una scansione in modalità di riserva sostituisce il catalogo ma non tocca `seen` né `firstScanAt`: altrimenti, al ritorno della CLI, tutti i comandi integrati risulterebbero nuovi. Per questo `firstScanAt` vale `null` finché la CLI non ha risposto almeno una volta.
- "Nuovo" si calcola al momento della lettura, non della scansione.

### Hash

- **Comandi con file sorgente**: SHA-256 del contenuto del file.
- **Builtin e `unknown`**: SHA-256 di nome, descrizione e `argumentHint` restituiti dalla CLI.

Serve a riconoscere un comando modificato dall'ultima scansione.

### Lingua

Le descrizioni restano nella lingua in cui arrivano dalla CLI o in cui le ha scritte l'autore: non vengono tradotte. Sono tradotti solo i testi dell'interfaccia e le etichette delle categorie.

### data/builtin-commands.json

Piccolo e curato a mano. Non contiene descrizioni dei comandi che la CLI già fornisce.

```jsonc
{
  "schemaVersion": 1,
  "categories": { "compact": "context", "clear": "session" },   // nome senza "/" → ID categoria
  "hidden": ["heapdump", "workflow-launch-exec"],               // oltre ai nomi che iniziano con "__"
  "extra": []                       // comandi solo interattivi, da aggiungere dopo verifica
}
```

Un builtin senza categoria finisce in `other`.

### Stato utente

```jsonc
{
  "schemaVersion": 1,
  "pinned": ["/compact"],
  "edits": {                        // solo i campi modificati dall'utente
    "/compact": { "description": "...", "guide": { "whenToUse": "..." } }
  },
  "workspaces": {                   // preferiti e modifiche sui comandi di progetto
    "<workspaceId>": { "pinned": ["/deploy"], "edits": {} }
  }
}
```

Regole dello stato utente:

- Campi modificabili: `description`, `category`, `guide.whenToUse`, `guide.example`, `guide.related`. Un valore `null` toglie la modifica dell'utente su quel campo, e torna visibile il valore del team o del catalogo.
- "Fissa" e "Modifica" richiedono che il comando sia nel catalogo in cache, perché il suo tipo decide dove salvare. "Togli dai preferiti" e "Ripristina" funzionano sempre, così si possono ripulire le voci di comandi non più esistenti. "Ripristina" toglie le modifiche ma non i preferiti.
- Preferiti e modifiche dei comandi definiti nel workspace (`custom-project`, `skill-project`) vanno sotto `workspaces.<workspaceId>`; tutti gli altri al livello globale.
- **Lo stato utente non si perde mai.** Se il file è illeggibile o ha una `schemaVersion` sconosciuta, in lettura si tratta come vuoto con un avviso, e in scrittura ci si rifiuta di sovrascriverlo. La scrittura è atomica.

### Override di team

Stessa forma di `edits`: per ogni comando, solo i campi da aggiungere o correggere. È il posto dove il team scrive quando usare un comando. Il core lo legge soltanto; se è malformato lo ignora con un avviso.

```jsonc
{
  "schemaVersion": 1,
  "commands": {
    "/deploy": { "category": "project", "guide": { "whenToUse": "Prima di ogni rilascio su dev01." } }
  }
}
```

### Vista risolta (M3)

È ciò che gli IDE e la skill mostrano. Si calcola a ogni lettura e non viene salvata:

1. catalogo dell'ultima scansione del workspace;
2. sopra, campo per campo, l'override di team;
3. sopra, campo per campo, le modifiche dell'utente;
4. aggiunta di `pinned: true | false` dallo stato utente, e di `isNew: true | false` e `firstSeenAt` dalla cache.

Dalla M3 `slashdeck scan` e `slashdeck get` restituiscono la vista risolta, non il catalogo grezzo. `scan` esegue la scansione e aggiorna la cache; `scan --cached` restituisce subito la vista risolta dell'ultima cache senza chiamare Claude Code, ed è ciò che gli IDE mostrano all'avvio prima di aggiornare.

La vista risolta contiene anche `categoryOrder`, l'elenco ordinato delle categorie presenti: i front-end mostrano i gruppi in quell'ordine senza ricalcolarlo.

Le origini dei campi della guida hanno chiavi piatte (`"guide.whenToUse": "team"`), così anche Kotlin le legge come una semplice mappa di stringhe.

Regole:

- Precedenza **per campo**: `user-edit` > `team` > `curated` > `cli` > `local-metadata` > `derived`.
- `team` e `user-edit` non entrano mai nella cache, quindi una nuova scansione **non può sovrascriverli**.
- "Aggiorna elenco" riscrive solo la cache.
- "Modifica descrizione" e "Fissa/Togli dai preferiti" scrivono solo nello stato utente.

### Categorie

Il campo `category` contiene un ID stabile, mai un'etichetta tradotta. Le etichette stanno nei file di traduzione dell'interfaccia.

| ID | Etichetta italiana | A chi si applica |
| --- | --- | --- |
| `project` | Progetto | `custom-project`, `skill-project` |
| `plugin:<nome>` | Plugin: `<nome>` | `plugin`, un gruppo per plugin |
| `personal` | Personali | `custom-user`, `skill-user` |
| `synced` | Sincronizzate | `skill-synced` |
| `session` | Sessione | builtin |
| `context` | Contesto | builtin |
| `model-permissions` | Modello e permessi | builtin |
| `review-git` | Review e Git | builtin |
| `mcp-plugins` | MCP e plugin | builtin |
| `config` | Configurazione | builtin |
| `other` | Altro | builtin senza categoria, `unknown` |

L'ordine della tabella è l'ordine di visualizzazione: prima ciò che è del progetto e del team. L'elenco è estendibile: un ID sconosciuto (es. aggiunto dal team) viene mostrato così com'è.

## Regole non negoziabili

- **Privacy**: il contenuto dei comandi custom, delle skill e dei plugin **non va mai inviato a motori di ricerca o servizi esterni**. La chiamata `initialize` non invia alcun prompt. L'unica eccezione futura è `claude -p` per generare spiegazioni (rimandata): invia il contenuto al provider che l'utente ha già configurato, quindi **non è un'elaborazione locale** e l'interfaccia non deve presentarla come tale.
- **Dati dell'account**: la risposta della CLI contiene informazioni sull'account. Non vanno mai salvate, scritte nei log o messe nelle fixture.
- **Nessuna ricerca web** per descrivere i comandi.
- **Trasparenza**: ogni testo mostra la sua origine (es. "Da Claude Code", "Dal team", "Modificato da te").
- **Nessuna chiave API** richiesta all'utente.
- I plugin IDE non devono rallentare l'avvio: mostrano subito la cache e aggiornano l'elenco in modo asincrono.

## Convenzioni

- TypeScript `strict`, ESM, Node LTS. Gestore pacchetti: pnpm workspaces.
- Bundling con esbuild in un singolo file, sia per la CLI inclusa nella skill sia per l'estensione VS Code. L'estensione VS Code esce in formato CJS anche se i sorgenti sono ESM, salvo verificare che la versione minima di VS Code supportata carichi estensioni ESM.
- `data/builtin-commands.json` sta fuori da `packages/core`: il build del core lo include nel proprio output. A runtime non va mai cercato con un percorso relativo alla repo.
- Test: vitest nel core, con fixture di cartelle `.claude/` finte in `packages/core/test/fixtures/`. **Nessun test deve chiamare la CLI reale di Claude Code**: la risposta di `initialize` si simula con una fixture sintetica, senza dati di account.
- Lint/format: eslint + prettier.
- Testi dell'interfaccia: italiano e inglese (i18n fin dall'inizio, inglese come default).
- Commit piccoli, messaggi in stile Conventional Commits.

## Comandi

> Da completare man mano che il progetto prende forma.

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r lint
pnpm --filter @slashdeck/core dev -- scan --workspace . --json   # prova la scoperta dai sorgenti
node packages/core/dist/cli.js scan --workspace . --json         # la stessa cosa dal build
node packages/core/dist/slashdeck.mjs scan --markdown            # catalogo leggibile, dalla CLI in un singolo file
pnpm --filter @slashdeck/skill install:project                   # copia la skill in .claude/skills/slashdeck/ (dopo il build)
pnpm --filter slashdeck run package                              # crea packages/vscode/slashdeck-<versione>.vsix
pnpm --filter slashdeck test:integration                         # avvia una copia isolata di VS Code con l'estensione (apre una finestra)
code --install-extension packages/vscode/slashdeck-0.1.1.vsix    # installa l'estensione nel proprio VS Code

# Plugin JetBrains: serve JAVA_HOME che punti a un JDK 21, e prima `pnpm -r build`
cd packages/jetbrains && ./gradlew test buildPlugin verifyPlugin  # produce build/distributions/slashdeck-jetbrains-<versione>.zip
```

In WebStorm il plugin si installa da Settings | Plugins | icona dell'ingranaggio | "Install Plugin from Disk…", scegliendo lo zip.

## Milestone

- **M0 – Validazione** (fatta il 2026-11-27): la CLI restituisce l'elenco dei comandi con descrizione, senza inviare prompt.
- **M1 – Core discovery** (fatta): chiamata `initialize`, scansione dei file, unione, categorie, `slashdeck scan --json`, test con fixture.
- **M2 – Skill di aiuto** (costruita e provata in questa repo): `scan --markdown`, CLI in un singolo file, `SKILL.md`. La prova con i colleghi resta da fare, ma non blocca più le tappe successive.
- **M3 – Stato e override di team** (fatta): cache per workspace, stato utente, override di team, vista risolta, comandi `scan --cached`, `get`, `pin`, `edit`, `reset`, `cache clear`.
- **M4 – Estensione VS Code** (costruita, versione 0.1.1; 169 test unitari, 11 controlli in un VS Code reale con una CLI finta, più una prova dell'aggiornamento automatico con il Claude Code reale): ricerca, TreeView, tooltip, Copia ed Esegui (solo con terminale `claude` rilevato), preferiti, badge "nuovo", watcher. La 0.1.0 aveva un ciclo infinito di scansioni ed è stata ritirata. Resta da provare a mano l'interfaccia.
- **M5 – Plugin JetBrains** per WebStorm, sopra la CLI del core (costruito: 52 test, verificatore di compatibilità superato). Resta da installare e provare in un WebStorm vero: non è mai stato visto in esecuzione.

Lavorare una milestone alla volta. Prima di iniziarne una, proporre un piano breve; alla fine, aggiornare questo file se architettura o comandi sono cambiati.

## Rimandati

Da riprendere solo se c'è una richiesta concreta. Le note qui sotto conservano quanto già deciso o verificato.

### Spiegazioni generate con `claude -p`

- **Solo su richiesta dell'utente**, mai in automatico: consuma la sua quota. Al primo uso, un avviso dice cosa viene inviato e a chi.
- I testi generati hanno origine `generated`, la più bassa in precedenza, e riempiono solo i campi mancanti. Se la sorgente o il prompt cambiano restano visibili, marcati "da aggiornare".
- **Isolamento**: eseguire `claude -p` in una cartella temporanea vuota, non nel workspace. Flag verificati su 2.1.318: `--tools ""` (nessun tool), `--strict-mcp-config` (nessun server MCP), `--disable-slash-commands` (nessuna skill o comando), `--output-format json`, `--json-schema <schema>` (output strutturato). **Non usare `--bare`**: disattiva il login OAuth e richiede `ANTHROPIC_API_KEY`, contro la regola "nessuna chiave API". Resta da capire come escludere gli hook dell'utente.
- **Input non fidato**: il corpo di un comando custom può contenere istruzioni. Va passato come dato delimitato, e il prompt deve dire di descriverlo senza eseguirlo.
- Risposta validata con zod; un solo retry, poi il comando resta senza spiegazione generata. Coda con concorrenza bassa (es. 2).

### Suggerimenti contestuali

- Regole semplici e disattivabili, mai invadenti (massimo un suggerimento ogni N minuti): molte modifiche non committate → `/code-review`; repo senza `CLAUDE.md` → `/init`; contesto alto → `/compact`, solo se il dato è ricavabile in modo affidabile.
- Un suggerimento viene mostrato solo se il comando suggerito è presente nel catalogo.

## Domande aperte

- `supportedCommands()` dell'Agent SDK è davvero l'equivalente documentato della chiamata `initialize`, e conviene dipendere dall'SDK invece che dal formato su stdin/stdout?
- Quali comandi solo interattivi mancano dall'elenco della CLI, oltre a quelli già notati (`help`, `permissions`, `resume`, `memory`)?
- Come si abbinano ai nomi della CLI i comandi custom in sottocartelle (`commands/<gruppo>/<nome>.md`)? Per ora il core accetta sia `<nome>` sia `<gruppo>:<nome>`.
- Qual è l'ordine di precedenza di Claude Code quando lo stesso nome compare in più sorgenti? Il core ne usa uno ipotizzato.
- 29 comandi integrati su 54 finiscono in `other` perché la loro descrizione non basta a classificarli. Vanno assegnati a mano, e forse servono categorie nuove.
- Non gestiti dalla scansione dei file: percorsi personalizzati di comandi e skill dichiarati in `plugin.json`, plugin disattivati dall'utente (in modalità di riserva compaiono comunque), skill gestite dall'organizzazione.
- Dalla M3 ogni invocazione della skill scrive la cache nella cartella reale dell'utente, perché `scan` la aggiorna. È voluto?
- Da Git Bash un nome con la barra iniziale (`/compact`) viene trasformato in un percorso di file: alla CLI va passato senza barra. Un processo avviato direttamente, come da JetBrains, non ha il problema.
- Due finestre che scrivono lo stato utente nello stesso istante: la scrittura è atomica e ricontrolla il file prima di rinominare, ma non c'è un vero blocco.
- Il percorso `.cmd` (installazione npm su Windows) è stato provato solo con uno script di prova; Linux e macOS non sono stati provati.
- L'estensione ufficiale di Claude Code per VS Code espone API o comandi per inviare un prompt al suo pannello? Verificato sulla 2.1.332: **no**. Tra i comandi che contribuisce non ce n'è uno per inviare testo; c'è però `claude-vscode.focus`, che porta il cursore nel campo di input. SlashDeck può quindi copiare il comando e spostare il cursore lì, lasciando all'utente l'incolla. È un identificativo non documentato: va usato solo se risulta registrato.
- "Esegui" invia il testo e poi un ritorno a capo separato al terminale. Con una CLI finta funziona; con il vero Claude Code non è stato provato.
- Dell'estensione VS Code non sono mai stati visti in una finestra reale: tooltip, ricerca, finestre di modifica, interfaccia in italiano, modalità con più cartelle, focus sul pannello di Claude Code dopo "Copia".
- Prima di pubblicare l'estensione vanno decisi editore, licenza e indirizzo della repository: oggi l'editore è provvisorio e il pacchetto si crea ignorando gli avvisi su licenza e repository.
- `activate()` dell'estensione restituisce una piccola API usata solo dalla prova in VS Code; è visibile anche ad altre estensioni e si potrebbe nascondere.
- Il plugin JetBrains usa API sperimentali del terminale per "Esegui": possono cambiare in una versione futura dell'IDE. Se cambiano, "Esegui" sparisce e resta "Copia". Il flusso non è mai stato provato con un terminale vero.
- Per WebStorm 2026.2 e 2026.3 la documentazione indica Java 25 come requisito di compilazione: il plugin è compilato su 2026.1 con JDK 21 e solo verificato sulla 2026.3.
- Il build del plugin JetBrains ha scaricato circa 9,5 GB in `~/.gradle` e `~/.pluginVerifier` (due versioni di WebStorm). Si possono eliminare; verranno riscaricati al prossimo build.
