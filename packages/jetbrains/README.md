# SlashDeck per WebStorm e IDE JetBrains

Plugin che mostra, in una finestra dell'IDE, i comandi slash disponibili in Claude Code per il progetto aperto: prima quelli del progetto e del team (comandi in `.claude/commands`, skill, comandi dei plugin), poi i comandi personali e infine quelli integrati. Per ogni comando dice da dove viene, se è nuovo e, quando il team lo ha scritto in `.claude/slashdeck.json`, quando usarlo.

Il plugin non contiene logica di scoperta: esegue con Node.js la CLI di SlashDeck (`slashdeck.mjs`, inclusa nel plugin) e ne mostra il risultato.

## Cosa fa

- **Albero dei comandi** nella finestra "SlashDeck" (a destra): Preferiti in cima (solo se ce ne sono), poi i gruppi nell'ordine deciso dal core. I gruppi del progetto e del team sono aperti, quelli dei comandi integrati chiusi. I comandi nuovi hanno l'etichetta **Nuovo**.
- **Dettagli** sotto l'albero: descrizione, argomenti, "quando usarlo", esempio, correlati, tipo, gruppo e file sorgente, ciascuno con la sua origine ("Da Claude Code", "Dal team", "Modificato da te"...). I testi dei comandi sono mostrati come testo semplice: non possono contenere link, immagini o altro contenuto remoto.
- **Filtro** per nome e descrizione: ogni parola scritta deve comparire nel nome, negli argomenti, nella descrizione o in "quando usarlo" (maiuscole e accenti non contano).
- **Azioni** (doppio clic, Invio o menù contestuale; "Copia" è sempre la prima): Copia, Esegui nel terminale di Claude Code, Apri il file sorgente, Aggiungi/Togli dai Preferiti, Modifica la descrizione, Modifica "quando usarlo", Ripristina le mie modifiche. Nella barra in alto: Aggiorna l'elenco, Espandi/Comprimi, Impostazioni.
- **Esegui** compare solo quando in una scheda del terminale dell'IDE è in esecuzione `claude`, rilevato tramite la shell integration del nuovo terminale (Bash, Zsh o PowerShell). Non crea mai un terminale. Se il comando accetta argomenti viene scritto senza Invio, così lo completi tu. Con il terminale "Classic", con `cmd.exe` o con la shell integration disattivata "Esegui" non compare: usa "Copia".
- **Aggiornamento**: all'apertura mostra subito l'elenco salvato, poi lo aggiorna in background. Si aggiorna anche quando cambiano i file `.md` in `.claude/commands`, i `SKILL.md` in `.claude/skills` o `.claude/slashdeck.json` del progetto, e quando riapri la finestra dopo più di 5 minuti. Gli aggiornamenti automatici sono al massimo uno al minuto; "Aggiorna l'elenco" funziona sempre subito.
- Finché non apri la finestra SlashDeck il plugin non fa nulla: nessun processo, nessuna lettura di file.

## Requisiti

- **Node.js 20 o successivo.** Il plugin lo cerca in quest'ordine: il percorso nelle impostazioni di SlashDeck; l'interprete Node.js configurato nell'IDE (solo in WebStorm e negli IDE con il plugin JavaScript, solo se locale); `node` dal PATH. Se Node manca o è troppo vecchio, la finestra lo dice e spiega cosa fare.
- **Claude Code** installato (`claude` nel PATH, oppure il percorso nelle impostazioni). Se non risponde, l'elenco contiene solo i comandi letti dai file e mancano quelli integrati; la finestra lo segnala.
- **IDE**: WebStorm 2026.1, 2026.2 o 2026.3 (build da 261 a 263.\*). Il plugin dipende solo dalla piattaforma, quindi si carica anche negli altri IDE JetBrains delle stesse versioni; lì l'interprete Node.js dell'IDE non viene usato.

Il plugin non usa la rete e non raccoglie dati di utilizzo. Claude Code viene avviato solo per leggere l'elenco dei comandi, senza inviare alcun prompt.

## Build

Serve un JDK 21 (per esempio Temurin 21). Gradle non va installato: c'è il wrapper. Il primo build scarica WebStorm (circa 1,2 GB) nella cartella di Gradle dell'utente.

```bash
# dalla radice della repo: costruisce anche packages/core/dist/slashdeck.mjs
pnpm install
pnpm -r build

cd packages/jetbrains
./gradlew buildPlugin     # crea build/distributions/slashdeck-jetbrains-<versione>.zip
./gradlew test            # test unitari, test con la CLI vera e test in un WebStorm headless
./gradlew verifyPlugin    # Plugin Verifier contro WebStorm 2026.3.0.1 (lo scarica)
```

Su Windows si usa `gradlew.bat` (o `.\gradlew` da PowerShell). Se `packages/core/dist/slashdeck.mjs` non esiste, il build si ferma e dice di eseguire prima `pnpm -r build`.

I test non avviano mai il vero Claude Code e non toccano le cartelle dell'utente: cache, stato e cartella di Claude Code sono cartelle temporanee o fixture.

## Installazione in WebStorm

1. Apri **Settings | Plugins** (in italiano: **Impostazioni | Plugin**).
2. Fai clic sull'icona a ingranaggio e scegli **Install Plugin from Disk...** (**Installa plugin dal disco...**).
3. Seleziona `packages/jetbrains/build/distributions/slashdeck-jetbrains-0.1.0.zip` e conferma.
4. Riavvia l'IDE se richiesto, poi apri la finestra **SlashDeck** dal bordo destro o da **View | Tool Windows | SlashDeck**.

## Impostazioni

In **Settings | Tools | SlashDeck** (**Impostazioni | Strumenti | SlashDeck**):

| Impostazione                                  | Effetto                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Eseguibile di Node.js                         | Percorso di `node`. Vuoto: interprete dell'IDE o `node` dal PATH. Se il percorso non esiste, la finestra lo segnala invece di cercarne un altro. |
| Usa l'interprete Node.js configurato nell'IDE | Attivo per default. Vale solo negli IDE con supporto JavaScript e per un interprete locale (non WSL o remoto).                                   |
| Eseguibile di Claude Code                     | Percorso di `claude`, passato alla CLI come `--claude-path`. Vuoto: `claude` dal PATH.                                                           |

Dopo una modifica Node viene ricontrollato e l'elenco aggiornato.

Preferiti e modifiche ai testi sono salvati dalla CLI nello stesso file usato dall'estensione VS Code e dalla skill (`%APPDATA%\slashdeck\state.json` su Windows), quindi valgono in tutti gli strumenti.
