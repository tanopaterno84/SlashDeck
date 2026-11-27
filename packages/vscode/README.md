# SlashDeck per VS Code

Mostra i comandi `/` disponibili in Claude Code per la cartella aperta: prima quelli del progetto e dei plugin del team, poi quelli personali e infine quelli integrati. Serve a sapere quali comandi e skill esistono e quando usarli, senza doverli conoscere in anticipo.

## Cosa fa

- **Cerca comando** (`SlashDeck: Search Command`, anche dall'icona della lente nella vista): cerca per nome e per descrizione, anche con più parole ("rivedere le modifiche", "deploy dev01"). Scegliendo un comando si aprono le sue azioni.
- **Vista nella Activity Bar** (icona SlashDeck): Preferiti in cima, poi Progetto, Plugin, Personali e i gruppi dei comandi integrati. I comandi nuovi hanno l'icona ✦ e la scritta "New"; il numero dei comandi nuovi compare sull'icona della vista.
- **Tooltip**: descrizione, argomenti, "quando usarlo", esempio, comandi correlati, file sorgente. Accanto a ogni testo c'è la sua origine: "From Claude Code", "From the team" (da `.claude/slashdeck.json`), "Edited by you" e così via.
- **Azioni** (clic su un comando, pulsanti in linea o menu contestuale):
  - **Copia**: copia il comando negli appunti. Se è installata l'estensione ufficiale di Claude Code, sposta anche il cursore nel suo pannello, così basta incollare (disattivabile).
  - **Esegui nel terminale di Claude Code**: compare solo se in un terminale integrato è stato rilevato `claude` in esecuzione. Scrive il comando in quel terminale; se il comando accetta argomenti, lo scrive senza inviarlo, così li completi e premi Invio. Non apre mai un terminale nuovo.
  - **Apri file sorgente**, **Aggiungi ai / Togli dai Preferiti**, **Modifica descrizione**, **Modifica "quando usarlo"**, **Ripristina le mie modifiche**.
- **Aggiornamento**: all'avvio mostra subito l'ultimo elenco salvato e lo aggiorna in background (Claude Code impiega qualche secondo a rispondere). Si aggiorna da solo quando cambia un file che definisce un comando: i `.md` di `.claude/commands`, i `SKILL.md` di `.claude/skills` (progetto e `~/.claude`), il registro e i manifest dei plugin installati. I file che Claude Code riscrive a ogni avvio (`manifest.json`, cartelle che iniziano con un punto come `.staging` o `.in_use`) non contano: prima di aggiornare, SlashDeck confronta un'impronta dei file dei comandi con quella dell'ultimo aggiornamento e, se non è cambiata, non avvia Claude Code. Fra due aggiornamenti automatici passano almeno 10 secondi; se le richieste continuano ad arrivare subito dopo ogni aggiornamento l'intervallo raddoppia, e dopo 5 aggiornamenti di fila quelli automatici si sospendono finché non usi **Aggiorna elenco**, che funziona sempre e subito. Una modifica a `.claude/slashdeck.json` ricarica la vista senza interrogare Claude Code. Durante un aggiornamento in background resta visibile l'elenco salvato.

Se Claude Code non risponde, la vista lo dice e mostra solo i comandi ricavati dai file: mancano i comandi integrati. In una cartella non attendibile (Modalità con restrizioni) Claude Code non viene avviato. Senza cartelle aperte vengono mostrati i comandi personali, dei plugin e integrati; in un workspace con più cartelle, quelli della prima cartella o di quella scelta con `SlashDeck: Select Workspace Folder`.

Il contenuto dei comandi non viene mai inviato altrove: SlashDeck chiede l'elenco a Claude Code senza inviare prompt, e non ha telemetria.

## Impostazioni

| Impostazione                         | Predefinito | Descrizione                                                                                                                                                                    |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slashdeck.claudePath`               | vuoto       | Percorso dell'eseguibile di Claude Code. Vuoto: la variabile `SLASHDECK_CLAUDE_PATH`, poi `claude` nel `PATH`. Si imposta solo a livello utente o macchina, non dal workspace. |
| `slashdeck.refreshOnStartup`         | `true`      | Aggiorna l'elenco in background all'avvio. Senza elenco salvato l'aggiornamento avviene comunque.                                                                              |
| `slashdeck.focusClaudeCodeAfterCopy` | `true`      | Dopo "Copia", porta il cursore nel pannello di Claude Code (solo se l'estensione ufficiale lo consente e non c'è un terminale con `claude` rilevato).                          |

L'interfaccia è in inglese e in italiano, secondo la lingua di VS Code.

## Build e installazione

Requisiti: Node.js 24 e pnpm, VS Code 1.93 o successivo.

```bash
pnpm install
pnpm -r build                                 # core, skill ed estensione
pnpm --filter slashdeck test                  # test unitari
pnpm --filter slashdeck test:integration      # apre un VS Code di prova (scaricato in .vscode-test/)
pnpm --filter slashdeck run package           # crea packages/vscode/slashdeck-0.1.1.vsix
```

Per installare il `.vsix`: in VS Code, vista Estensioni → menu `...` → **Install from VSIX...**, oppure

```bash
code --install-extension packages/vscode/slashdeck-0.1.1.vsix
```

Il publisher `slashdeck-placeholder` è provvisorio, e il progetto non ha ancora una licenza né un repository pubblico: lo script di packaging lo segnala a `vsce` con `--skip-license` e `--allow-missing-repository`. Vanno decisi prima di pubblicare l'estensione.
