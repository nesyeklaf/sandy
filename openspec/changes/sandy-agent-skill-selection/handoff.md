# Fortsetzungsprompt: Sandy-only Skill-Auswahl

Historische Übergabe vor der Pi-SDK-Entscheidung. Für den aktuellen Stand gelten [tasks.md](tasks.md) und die [Pi-SDK-Verifikation](verification-pi-sdk-a.md); insbesondere ist Design A inzwischen gewählt und lokal implementiert. Claude/Codex bleiben offen (Owner: später). Daraus folgt keine Freigabe für Push, Installation oder Deploy.

Übernimm die angefangene Implementierung im Repository `git@github.com:nesyeklaf/sandy.git`, Branch `openspec-proposal-sandy-only-agent-skill-selecti-thr_fgq63pyp84`. Arbeite vom gepushten WIP dieses Branches weiter, nicht von `main`. Lies zuerst `AGENTS.md`, `README.md` und die Dateien in `openspec/changes/sandy-agent-skill-selection/`, insbesondere `proposal.md`, `design.md`, `specs/agent-skill-selection/spec.md`, `tasks.md` und `verification-5d8b7af20.md`. Prüfe Branch, HEAD und Working Tree, ohne fremde Änderungen zu überschreiben. Die Checklisten sind kein Nachweis vollständiger Durchsetzung.

## Auftrag und Entscheidungen des Owners

Implementiere eine Sandy-weite, gemeinsame Auswahl nach Skill-Namen für Pi, Codex und Claude Code: einzelne oder viele Skills aus, alle aus, nur ausgewählte an, Rückkehr zu den bisherigen Defaults. UI, CLI und SDK verwenden dieselbe Mutation. Jede Kopie eines Namens wird gemeinsam geschaltet. Bereits deaktivierte Sandy-Quellen bleiben deaktiviert.

Die Auswahl gilt ausschließlich für von Sandy gestartete bzw. wiederhergestellte Agentensitzungen. Normale CLI-Starts und ihre Konfiguration bleiben unverändert. Keine Provider-Konfigurationsdateien oder Skill-Dateien umschreiben, nichts deinstallieren, keine ganzen Plugins/Extensions/Workflows als Ersatz für Skill-Filter deaktivieren. Kein eigener Provider-Home-Fallback. Die Auswahl ist keine Dateizugriffssperre.

Direktes OpenSpec, ausdrücklich OHNE HOLONS. Bestehende Holon-Dateien nicht verändern oder als Gate verwenden. Die zwei früheren, ungetrackten Holon-Entwürfe des alten Servers sind nicht Teil dieses Handoffs und werden nicht benötigt. Ideen gehören ins zentrale master-repo, nicht automatisch in GitHub-Issues. Sandy-Plugins und Sandy-spezifische Pi-Extensions werden im Sandy-Repository entwickelt.

Lokale Implementierung und notwendige Checks sind beauftragt. Der Owner hat den vorherigen Lauf gestoppt und anschließend den Stand für diesen Handoff pushen lassen. Daraus folgt KEINE pauschale Freigabe für weitere Pushes, PR/MR-Erstellung, Merge, Release, Deploy, produktive Konfigurationsänderungen oder neue kostenpflichtige Modell-Probes. Vor solchen Schritten ausdrücklich fragen. Die alte Freigabe für zwei Live-Claude-Varianten ist verbraucht; keine weiteren Live-Modell-Turns. Niemals Secrets auslesen oder ausgeben.

## Vorhandener Stand

- Policy `inherit | disable(names) | allow-only(names)`, separate Sandy-Speicherung, GET/PUT `/settings/skill-selection`, SDK `skills.experimental_getSelection`/`experimental_setSelection`, CLI `sandy skill selection`.
- Skills-Seite mit Row-/Detail-Schaltern, Sammelauswahl, Off-Markierungen, Herkunftsinformationen, Provider-Status und Stop-Hinweis. Gleiche Mutation und Namenslogik über alle Oberflächen.
- Policy wird mit `skills/configure` an die Provider geliefert; Host-Daemon-Protokoll ist absichtlich auf 266 erhöht.
- Eine reine Auswahländerung ersetzt keine geladenen Sitzungen. Neue Sitzungen erhalten die neue Auswahl; geladene behalten ihre Auswahl bis Stop oder Retirement ihrer Idle-Sitzung. Kein automatischer Neustart. `pendingThreadIds` erfasst nur laufende Turns, nicht alle geladenen Idle-Threads; dafür fehlt ein Daemon-Report.
- Der Server stellt den quellengefilterten, aber NICHT nach Namensauswahl gefilterten Katalog bereit. Provider filtern beim Start. Dadurch ändert die Auswahl allein nicht den Kataloghash und löst keinen Idle-Runtime-Ersatz aus.
- Letzter breit geprüfter Code-Commit: `5d8b7af205f74acf735f5b67e176e7ea70cda760`. Er korrigiert insbesondere thread-spezifische Umgebungen für Pi/Claude-Discovery, Pi-Default-Trust, Fail-closed bei Discovery-Fehlern, Codex-Erhalt bereits deaktivierter Skills und doppelte Herkünfte.
- Der nachfolgende WIP enthält Textkorrekturen, ehrlichere Verifikationsmetadaten und zwei Test-Fixture-Korrekturen. Kein abschließend grüner Nachlauf wurde vor dem Stopp eingesammelt.

## Verifikation: beobachtet, nicht behauptet

Die übertragbare Zusammenfassung steht in `verification-5d8b7af20.md`. Die Rohlogs, JSON-Berichte und Screenshots des alten Servers werden NICHT vorausgesetzt und sind nicht mitgepusht.

Bei `5d8b7af20` bestanden App-Typecheck, gezielte Server-, Domain-, SDK- und CLI-Tests, die vollständigen Agent-Runtime-/Host-Daemon-Suiten sowie die echten Claude-/Codex-Initialisierungsprobes ohne Modell-Turn. Pi-Trust- und Codex-Fail-closed-Replays bestanden. Ein Lifecycle-Probe über echtes `createAgentRuntime` mit einem scripted-echo-Testtransport behielt die alte Sitzung auf ihrer Policy und nutzte die neue Policy bei neuen bzw. gestoppt/wiederaufgenommenen Sitzungen. Das ist KEIN nativer Provider- oder Server-End-to-End-Nachweis.

Offene Nachläufe:

1. `apps/app/src/views/SkillsView.test.tsx`: zuletzt 144/145 in der App-Zielgruppe. Sammelauswahl erwartete zwei Suchtreffer, bekam drei. Ursache im Fixture: der vermeintlich nicht passende Skill `deploy` erbte eine Beschreibung mit dem Suchwort `review`. Der WIP gibt ihm eine passende eigene Beschreibung und prüft zusätzlich seine Abwesenheit; ursprüngliche Policy-Assertions bleiben erhalten. Das war kein bewiesener Debounce-Fehler.
2. `plugins/provider-pi/src/bridge/skill-selection.test.ts`: Environment-Test scheiterte in Default- und echtem Pi-Lauf, zuletzt 15/16. Er speicherte die `process.env`-Referenz und stellte die Stub-Variablen vor der Assertion wieder her. Der WIP kopiert `launchEnv` im Callback; die Assertions bleiben erhalten. Nachlauf ausstehend.
3. Ein Pi-Interruption-Test mit 5-Sekunden-Limit und mehrere echte Pi-Resolver-Prozesse liefen unter hoher Maschinenlast in Timeouts. Der Interruption-Test bestand allein 28/28; beim wiederholten echten Pi-Lauf blieb nur der Environment-Fixture-Fehler. Seriell bei niedriger Last prüfen, nicht reflexartig Timeouts erhöhen.
4. CLI-Hilfe und Guide aus dem neuen Source-Stand sind noch nicht final geprüft; OpenSpec 5.3 bleibt offen.

Browserbeobachtungen: Einzel-/Sammelaktionen, Namensduplikate, Persistenz, CLI-Readback und manueller Stop ohne automatischen Neustart waren im isolierten Dev geprüft. Bei 390 px sind Off-Chips nicht mehr abgeschnitten, Duplikatpfade per Tastatur und Touch-Detail erreichbar. Verbleibende UX-Punkte: kleine Herkunfts-/Included-Badges werden ellipsiert; Screenreader und echte Touch-Geräte wurden nicht geprüft. Letzte Textkorrekturen wurden nicht erneut im Browser abgenommen. Die eigene Dev-Instanz war beim Handoff beendet. Starte auf dem neuen Server eine eigene isolierte Instanz; keine alten Ports oder absoluten Pfade übernehmen.

## Provider-Grenzen: NICHT akzeptiert, Feature NICHT fertig

Alle drei Provider bleiben für vollständige Session-Durchsetzung `unverified`. Nie wegen grüner Unit- oder Initialisierungstests auf `enforced` umstellen.

- Pi: `--no-skills` plus explizite `--skill`-Pfade filtert Native-/Package-/Sandy-Skills, aber Extensions können über `resources_discover` danach Skills ergänzen. Zwei `it.fails`-Tests zeigen diese Lücke; erwartetes Scheitern ist kein Enforcement-Erfolg. Ein Extension-Handler für `project_trust` kann zudem Projektvertrauen anders entscheiden als der vorgelagerte Resolver und dadurch gewünschte Projekt-Skills verlieren. Der SDK-`ResourceLoader.skillsOverride` wäre ein vollständigerer Ladepunkt; CLI/RPC bietet ihn nicht. Ein SDK-Brückenumbau wäre eine neue Designentscheidung, kein beiläufiger Fix. Keine fragile Prompt-Umschreibung ohne Owner-OK.
- Claude: `settings.skillOverrides` filtert native Skills; Sandy filtert seine injizierten Plugin-Skills. Claude-eigene gebündelte und Marketplace-Plugin-Skills bleiben Lücken. Subagent-Verhalten ist unbewiesen; bisherige Live-Probes waren inkonklusiv. `Options.skills` ist keine Lösung: es erzeugt eine Skill-Allow-Regel, keinen Ladefilter. `disableBundledSkills` würde nur Gebündeltes erreichen, nicht Marketplace, und auch Workflows entfernen; nicht eigenmächtig aktivieren.
- Codex: launch-time `skills.config` erhält bereits durch den Nutzer deaktivierte Skills und bricht bei fehlgeschlagenem `skills/list` ab. Bei `allow-only` können nach Prozessstart hinzugefügte Skills trotzdem erscheinen.

Der Owner hat KEINE dieser Lücken akzeptiert. Vollständig erledigt ist die ursprüngliche Anforderung erst mit nachgewiesener Durchsetzung oder ausdrücklicher Einzelakzeptanz der benannten Einschränkungen. OpenSpec 6.1 bleibt offen. Keine stillschweigende Scope-Reduktion.

## Erster sicherer nächster Schritt

Prüfe den gepushten WIP und führe NUR die betroffenen Abschlusschecks seriell aus: App `SkillsView`, `realtime-cache-effects`, `detail-page-recipes` plus Typecheck; CLI `skill.test.ts`; Pi Default `skill-selection`/`bridge.interruption-recovery`, dann echte `skill-selection`/`pi-package-skills` mit dem auf diesem Server installierten Pi. Beachte `.nvmrc` (zuletzt Node 26.13.0), pnpm und die Turbo-Regeln des Repos. Die Real-Gates heißen `SANDY_TEST_REAL_PI_COMMAND`, `SANDY_TEST_REAL_CLAUDE`, `SANDY_TEST_REAL_CODEX`; Binary-Pfade hier neu ermitteln. Keine neuen Modell-Turns.

Prüfe source-eigenes `sandy skill selection --help` und `sandy guide agent-configuration`. Wichtig: Ein geerbtes `SANDY_CLI` lässt offizielle Entrypoints auf die produktive CLI re-execen. Für Source-Checks diese Variable entfernen und den Checkout-Entrypoint verwenden. Für Browserchecks eigenes Fixture-HOME und bereinigte Umgebung verwenden; nicht versehentlich mit produktivem Server oder Provider-Konfiguration arbeiten.

Speichere Berichte mit getestetem SHA und Dirty-State. Lies die realen Ergebnisse, bevor du `tasks.md` abhaken oder einen neuen Commit als verifiziert bezeichnen willst. Prüfe die direkte OpenSpec-Änderung mit `openspec validate --strict`. Danach dem Owner knapp den verifizierten Teil und die verbleibenden Provider-Entscheidungen zeigen. Nicht erneut eine breite Review-/Probe-Schleife starten: eine unabhängige Review und ein Risiko-Review fanden die bereits korrigierten ENV-/Trust-/Fail-open-/Lifecycle-Probleme; zusätzliche Checks nur bei neuen Änderungen oder konkreten Fehlern.
