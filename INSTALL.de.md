# Installationsanleitung (dsh-prime-memory)

Dieses Plugin wird als **offizielles DSH-Bundle** ausgeliefert: Nach der Installation mountet die `dsh.bundle`-Schicht in `cordis.patch.yml` den Plugin-Eintrag automatisch — manuelle Profilbearbeitung ist nicht erforderlich.

## Voraussetzungen

- Node.js ≥ 22.16 (DSH 0.2.0-rc.1 oder neuer)
- DeepSeek Harness (im Folgenden DSH) installiert, mit verfügbarem `--profile web`

## Installation

Wählen Sie eine der folgenden Aufrufarten (das Präfix `npx` kann in jedem der folgenden Befehle `dsh` ersetzen):

```bash
# Variante 1: offizielle CLI direkt per npx ausführen (kein vorinstalliertes dsh nötig; Version kann gepinnt werden, z. B. dsh-prime-memory@0.8.4)
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# Variante 2: mit installierter dsh-CLI (dsh ist ein pnpm-Forwarder; falls pnpm fehlt, zuerst npm i -g pnpm)
dsh plugin --profile web add dsh-prime-memory

# Alternative Paketquellen: GitHub-Repository / lokaler Pfad (Entwicklung/Debug; link: verweist auf das Repository, npm run build + dsh-Neustart genügt)
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Installation durch den Agenten (empfohlen)

Senden Sie die folgende Nachricht unverändert an den aktuellen Agenten (sofern er Terminalbefehle ausführen kann):

```text
Bitte installiere das Plugin dsh-prime-memory für das Web-Profil von DeepSeek Harness.

Führe ausschließlich die beiden folgenden Befehle aus und ändere keine anderen Profile:
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

Sobald dsh-prime-memory in der Ausgabe erscheint, melde mir das Installationsergebnis.
Beende oder starte den laufenden DSH nicht selbst neu; erinnere mich nach der Installation daran, den DSH Web Host manuell neu zu starten.
```

## Update

```bash
# Auf die neueste Version aktualisieren
dsh plugin --profile web update dsh-prime-memory

# Auf eine bestimmte Version aktualisieren
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

Ein Update ersetzt nur den Plugin-Code und die `dist/`-Artefakte; das Datenverzeichnis `~/.dsh/memory/` bleibt unberührt.

## Verifikation

Prüfen Sie nach der Installation und dem Neustart des DSH Web Host:

1. **Das Datenverzeichnis entsteht** — das Plugin wurde erfolgreich angewendet: unter `~/.dsh/memory/` erscheinen die Verzeichnisse `conversations/`, `records/`, `scenes/` sowie `memory.db`;
2. **Die Seite „Memory" erscheint in den Einstellungen** und das Modus-Pill erscheint in der Eingabeleiste — die Client-Hälfte ist bereit;
3. Schicken Sie eine Nachricht mit persönlichen Informationen, warten Sie die Destillation ab und fragen Sie in einem späteren Zug danach: Im Kontext sollte die Zeile „Kontextinjektion · memory" erscheinen.

Optionaler Rauchtest (Entwicklung/Fehlerdiagnose):

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## Migration / Downgrade

- **Migration von der alten Version (vor 0.5.0 hieß das Paket `dsh-memory-plugin`)**: Das alte Datenverzeichnis ist mit dem neuen Paket inkompatibel; sichern Sie es und löschen Sie `~/.dsh/memory/` — es wird beim ersten Start des neuen Plugins neu aufgebaut. Bestehende Erinnerungen können nicht direkt übernommen werden, sie müssen neu destilliert werden.
- **Zurück zur alten Version**: Nach `dsh plugin --profile web remove dsh-prime-memory` gemäß der Dokumentation der alten Version neu installieren; das Datenverzeichnis bleibt erhalten, aber die alte Version erkennt die neue Struktur nicht — eine Bereinigung wird empfohlen.

## Deinstallation

```bash
dsh plugin --profile web remove dsh-prime-memory
```

Die Daten bleiben in `~/.dsh/memory/`; löschen Sie bei Bedarf das gesamte Verzeichnis von Hand.

## Fehlerbehebung

| Symptom | Wahrscheinliche Ursache | Lösung |
| --- | --- | --- |
| Nach der Installation fehlt die Seite „Memory" in den Einstellungen | DSH nicht neu gestartet / Bundle nicht gemountet | DSH Web Host neu starten; mit `dsh --profile web --dump-config` prüfen, dass `dsh-prime-memory` enthalten ist |
| `duplicate loader entry id` beim Neustart | ein manuell hinzugefügtes `insert:` kollidiert mit dem Bundle-Eintrag gleicher id | Das manuell hinzugefügte `insert:`-Element entfernen; das Paket bringt seine Bundle-Schicht bereits mit |
| Keine Zeile „Kontextinjektion · memory" | Destillation nicht gelaufen / Recall deaktiviert | Prüfen, dass der Modus nicht off und `recall.enabled=true` ist; in `memory.log` nach `L1 阶段完成` suchen |
| Download des lokalen Embedding-Modells hängt | Mirror direkt nicht erreichbar | `embedding.proxy` setzen, um über einen Proxy zu gehen; oder `embedding.mirror` auf das offizielle `huggingface.co` umstellen |
| Remote-Embedding meldet 401 | apiKey falsch / schlüsselloser Dienst darf keinen Key erhalten | `embedding.apiKey` prüfen; bei einem selbst gehosteten Dienst ohne Key apiKey leer lassen |

Mehr dazu in [README.md](./README.md) und [CHANGELOG.md](./CHANGELOG.md).
