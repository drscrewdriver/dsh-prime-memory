# Guide d'installation (dsh-prime-memory)

Ce plugin est distribué sous forme de **bundle officiel DSH** : après l'installation, la couche `dsh.bundle` de `cordis.patch.yml` monte automatiquement l'entrée du plugin — aucune modification manuelle du profil n'est nécessaire.

## Prérequis

- Node.js ≥ 22.16 (DSH 0.2.0-rc.1 ou supérieur)
- DeepSeek Harness (ci-après DSH) installé, avec `--profile web` disponible

## Installation

Choisissez librement l'un des modes d'invocation suivants (le préfixe `npx` peut remplacer `dsh` dans n'importe laquelle des commandes ci-dessous) :

```bash
# Méthode 1 : lancer le CLI officiel directement via npx (pas besoin d'installer dsh au préalable ; la version peut être épinglée, ex. dsh-prime-memory@0.8.4)
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# Méthode 2 : avec le CLI dsh installé (dsh est un relais pnpm ; si pnpm manque, commencez par npm i -g pnpm)
dsh plugin --profile web add dsh-prime-memory

# Sources de paquets alternatives : dépôt GitHub / chemin local (développement/débogage ; link: pointe vers le dépôt, npm run build + redémarrage de dsh suffisent)
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Laisser l'agent installer (recommandé)

Envoyez tel quel le message ci-dessous à l'agent actuel (du moment qu'il peut exécuter des commandes de terminal) :

```text
Veuillez installer le plugin dsh-prime-memory pour le profil web de DeepSeek Harness.

Exécutez uniquement les deux commandes suivantes, sans modifier d'autres profils :
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

Une fois que dsh-prime-memory apparaît dans la sortie, confirmez-moi le résultat de l'installation.
Ne fermez pas et ne redémarrez pas vous-même le DSH en cours d'exécution ; après l'installation, rappelez-moi de redémarrer manuellement le DSH Web Host.
```

## Mise à jour

```bash
# Mettre à jour vers la dernière version
dsh plugin --profile web update dsh-prime-memory

# Mettre à jour vers une version donnée
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

La mise à jour ne remplace que le code du plugin et les artefacts de `dist/` ; le répertoire de données `~/.dsh/memory/` n'est pas affecté.

## Vérification

Après l'installation et le redémarrage du DSH Web Host, vérifiez :

1. **Le répertoire de données apparaît** — le plugin s'est appliqué avec succès : sous `~/.dsh/memory/` apparaissent les répertoires `conversations/`, `records/`, `scenes/` ainsi que `memory.db` ;
2. **La page « Mémoire » apparaît dans les paramètres** et le pill de mode s'affiche dans la barre de saisie — la moitié client est prête ;
3. Envoyez un message contenant des informations personnelles, attendez la fin de la distillation, puis demandez ces informations dans un autre tour de conversation : la ligne « Injection de contexte · memory » doit apparaître dans le contexte.

Test de fumée optionnel (développement/diagnostic) :

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## Migration / retour à une version antérieure

- **Migration depuis l'ancienne version (nommée `dsh-memory-plugin` avant le 0.5.0)** : l'ancien répertoire de données est incompatible avec le nouveau paquet ; sauvegardez puis supprimez `~/.dsh/memory/`, il sera reconstruit au premier démarrage du nouveau plugin. Les mémoires existantes ne peuvent pas être mises à niveau directement, une re-distillation est nécessaire.
- **Revenir à l'ancienne version** : après `dsh plugin --profile web remove dsh-prime-memory`, réinstallez en suivant la documentation de l'ancienne version ; le répertoire de données est conservé, mais l'ancienne version ne reconnaît pas la nouvelle structure — un nettoyage est recommandé.

## Désinstallation

```bash
dsh plugin --profile web remove dsh-prime-memory
```

Les données restent dans `~/.dsh/memory/` ; supprimez manuellement tout le répertoire si vous n'en avez plus besoin.

## Dépannage

| Symptôme | Cause probable | Solution |
| --- | --- | --- |
| Aucune page « Mémoire » dans les paramètres après l'installation | DSH non redémarré / bundle non monté | Redémarrez le DSH Web Host ; vérifiez avec `dsh --profile web --dump-config` que `dsh-prime-memory` figure bien dans la configuration |
| `duplicate loader entry id` au redémarrage | un `insert:` ajouté manuellement coexiste avec l'entrée bundle de même id | Supprimez l'entrée `insert:` ajoutée à la main ; ce paquet embarque déjà sa couche bundle |
| Aucune ligne « Injection de contexte · memory » | distillation non exécutée / rappel désactivé | Vérifiez que le mode n'est pas off et que `recall.enabled=true` ; cherchez `L1 阶段完成` dans `memory.log` |
| Téléchargement du modèle d'embedding local bloqué | miroir inaccessible en connexion directe | Configurez `embedding.proxy` pour passer par un proxy ; ou remplacez `embedding.mirror` par l'officiel `huggingface.co` |
| Erreur 401 de l'embedding distant | apiKey erronée / service sans clé auquel il ne faut pas en envoyer | Vérifiez `embedding.apiKey` ; laissez apiKey vide pour un service auto-hébergé sans clé |

Pour aller plus loin, voir [README.md](./README.md) et [CHANGELOG.md](./CHANGELOG.md).
