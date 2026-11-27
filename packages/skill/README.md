# SlashDeck: skill di aiuto per Claude Code

Una skill che risponde alle domande sui comandi `/` disponibili nella sessione di Claude Code: quelli del progetto, dei plugin di team, personali e integrati. Funziona allo stesso modo nel terminale, in VS Code e in JetBrains, e richiede solo Node.js.

## Cosa fa

Quando viene invocata, la skill esegue la CLI di SlashDeck (inclusa nella skill, in un unico file) che chiede l'elenco dei comandi a Claude Code e lo collega ai file sorgente. Claude risponde solo a partire da quell'elenco:

- `/slashdeck` senza argomenti: panoramica dei comandi per gruppo, prima quelli del progetto e dei plugin, poi in breve quelli integrati;
- `/slashdeck <comando>` (es. `/slashdeck wiki`): spiega il comando; per i comandi custom legge il file sorgente se la descrizione non basta;
- `/slashdeck <cosa vuoi fare>` (es. `/slashdeck voglio documentare un'analisi`): consiglia il comando o i comandi da usare, oppure dice chiaramente che nessuno è adatto.

Per ogni comando mostra il testo esatto da digitare e risponde nella lingua della domanda. Claude può usare la skill anche da solo, quando chiedi quali comandi esistono.

La chiamata a Claude Code non invia prompt e non consuma quota. Se `claude` non risponde, la skill usa solo i file dei comandi e delle skill e lo dice: in quel caso mancano i comandi integrati.

## Requisiti

- Node.js 20 o successivo nel `PATH` (provato con Node 24.15 su Windows).
- Claude Code (provato con la 2.1.318).

## Provarla in una repo

Da questa repo:

```bash
pnpm install
pnpm -r build
pnpm --filter @slashdeck/skill install:project   # copia in .claude/skills/slashdeck/ (ignorata da git)
```

Per un'altra repo, copiare la cartella `packages/skill/dist/slashdeck/` in `<repo>/.claude/skills/slashdeck/` (oppure in `~/.claude/skills/slashdeck/` per averla in tutti i progetti). Poi aprire Claude Code nella repo e digitare `/slashdeck`. Se la sessione era già aperta prima della copia, potrebbe servire riavviarla.

## Aggiungerla a un plugin di team come `help`

Per averla come `/<plugin>:help` (es. `/gxrr:help`):

1. Copiare `packages/skill/dist/slashdeck/` nel plugin come `skills/help/`:

   ```
   <plugin>/
   ├── .claude-plugin/plugin.json
   └── skills/
       └── help/
           ├── SKILL.md
           └── scripts/slashdeck.mjs
   ```

2. In `skills/help/SKILL.md` cambiare il frontmatter `name: slashdeck` in `name: help`. Il resto del testo non va cambiato.
3. Pubblicare una nuova versione del plugin; chi lo aggiorna trova `/<plugin>:help`.

**Percorso dello script**: se `scripts/` resta dentro la cartella della skill, non va cambiato nulla. `${CLAUDE_SKILL_DIR}` indica la cartella che contiene `SKILL.md` anche nei plugin (per una skill di plugin è `skills/help/`, non la radice del plugin). Se invece si preferisce mettere lo script altrove nel plugin, per esempio in `<plugin>/scripts/slashdeck.mjs` per condividerlo tra più skill, in `SKILL.md` va sostituito `${CLAUDE_SKILL_DIR}/scripts/slashdeck.mjs` con `${CLAUDE_PLUGIN_ROOT}/scripts/slashdeck.mjs` (variabile disponibile solo nelle skill di plugin) in tre punti: la riga `allowed-tools` del frontmatter e le due righe con il comando `node`.

## Come ottiene l'elenco

`SKILL.md` usa l'iniezione di comandi documentata da Claude Code (blocco di codice che inizia con tre backtick seguiti da `!`): il comando `node .../scripts/slashdeck.mjs scan --markdown` viene eseguito quando la skill è invocata e il suo output prende il posto del blocco, prima che Claude legga la skill. Se l'esecuzione dei comandi nelle skill è disattivata (impostazione `disableSkillShellExecution`), la skill chiede a Claude di eseguire lo stesso comando con il suo strumento shell, e in quel caso Claude Code può chiedere il permesso.

Il frontmatter `allowed-tools` approva in anticipo due cose, solo nel turno in cui la skill è invocata:

- `Read`, per leggere i file sorgente dei comandi senza chiedere conferma;
- `Bash(node "${CLAUDE_SKILL_DIR}/scripts/slashdeck.mjs" scan *)`, cioè solo lo script della skill. Senza questa regola il comando viene bloccato con l'errore "This command requires approval" (verificato su Claude Code 2.1.318).

Se Node.js manca, l'invocazione si interrompe con l'errore del comando `node`.
