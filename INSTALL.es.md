# Guía de instalación (dsh-prime-memory)

Este plugin se distribuye como **bundle oficial de DSH**: tras la instalación, la capa `dsh.bundle` de `cordis.patch.yml` monta automáticamente la entrada del plugin; no hace falta editar a mano ningún perfil.

## Requisitos

- Node.js ≥ 22.16 (DSH 0.2.0-rc.1 o superior)
- DeepSeek Harness (en adelante DSH) instalado, con `--profile web` disponible

## Instalación

Elige el modo de invocación que prefieras (el prefijo `npx` puede sustituir a `dsh` en cualquiera de los comandos siguientes):

> Los comandos siguientes solo aplican al host DSH CLI y `--profile web`; **los usuarios de DSH Desktop (Electron) no necesitan pnpm/npm** — el perfil de escritorio lo gestiona la aplicación en exclusiva, instala este plugin desde la página de plugins de la app.

```bash
# Modo 1: ejecutar la CLI oficial directamente con npx (no requiere dsh preinstalado; se puede fijar la versión, p. ej. dsh-prime-memory@0.8.4)
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# Modo 2: con la CLI dsh ya instalada (dsh es un reenviador de pnpm; si no tienes pnpm, antes npm i -g pnpm)
dsh plugin --profile web add dsh-prime-memory

# Fuentes alternativas del paquete: repositorio de GitHub / ruta local (desarrollo y depuración; link: apunta al repositorio, basta npm run build + reiniciar dsh)
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Dejar que el agente instale (recomendado)

Envía tal cual el siguiente mensaje al agente actual (siempre que pueda ejecutar comandos de terminal):

```text
Instala el plugin dsh-prime-memory para el perfil web de DeepSeek Harness.

Ejecuta solo los dos comandos siguientes y no modifiques otros perfiles:
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

Cuando aparezca dsh-prime-memory en la salida, infórmame del resultado de la instalación.
No cierres ni reinicies por tu cuenta el DSH en ejecución; cuando termine la instalación, recuérdame que reinicie manualmente el DSH Web Host.
```

## Actualización

```bash
# Actualizar a la última versión
dsh plugin --profile web update dsh-prime-memory

# Actualizar a una versión concreta
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

La actualización solo reemplaza el código del plugin y los artefactos de `dist/`; el directorio de datos `~/.dsh/memory/` no se ve afectado.

## Windows: cierra el runtime de DSH antes de instalar / actualizar

En Windows, mientras el host de escritorio DSH esté en ejecución, instalar / actualizar **cualquier** plugin desde la página de plugins puede hacer que pnpm (distribución hoisted) re-vincule todo el árbol `node_modules` de primer nivel y renombre las dependencias nativas de este plugin, `@node-rs/jieba` / `sqlite-vec`, para colocar copias nuevas. El host mantiene abiertos `jieba.*.node` / `vec0.dll`, y Windows aplica un bloqueo exclusivo sobre las imágenes cargadas, por lo que el cambio de nombre falla y la actualización revierte (EPERM, se informa como `previous build is incomplete`).

Solución: **cierra por completo DSH antes de ejecutar pnpm / `dsh plugin add|update`**, confirma que no queden procesos, instala y luego reinicia:

```powershell
# debe devolver vacío antes de instalar / actualizar
Get-Process | Where-Object { $_.ProcessName -match 'dsh|deepseek|electron' }
```

No es un fallo del plugin: el origen es el flujo de actualización de plugins del host más los bloqueos de archivos de Windows; cerrar el runtime libera el bloqueo y vale para actualizar cualquier plugin.

## Verificación

Tras instalar y reiniciar el DSH Web Host, comprueba:

1. **Aparece el directorio de datos** — el plugin se aplicó correctamente: bajo `~/.dsh/memory/` aparecen los directorios `conversations/`, `records/`, `scenes/` y el archivo `memory.db`;
2. **Aparece la página «Memoria» en los ajustes** y en la barra de entrada aparece la píldora de modo — la mitad cliente está lista;
3. Envía un mensaje con información personal, espera a que termine la destilación y pregunta por ello en otro turno de conversación: en el contexto debería verse la línea «Inyección de contexto · memory».

Smoke test opcional (desarrollo/diagnóstico):

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## Migración / retroceso

- **Migrar desde la versión antigua (antes de 0.5.0 se llamaba `dsh-memory-plugin`)**: el directorio de datos antiguo es incompatible con el paquete nuevo; haz una copia de seguridad y borra `~/.dsh/memory/`, el nuevo plugin la reconstruirá en su primer arranque. Las memorias existentes no se pueden actualizar directamente: hay que volver a destilarlas.
- **Volver a la versión antigua**: tras `dsh plugin --profile web remove dsh-prime-memory`, reinstala siguiendo la documentación de la versión antigua; el directorio de datos se conserva, pero la versión antigua no reconoce la nueva estructura; conviene limpiarlo.

## Desinstalación

```bash
dsh plugin --profile web remove dsh-prime-memory
```

Los datos permanecen en `~/.dsh/memory/`; si ya no los necesitas, borra todo el directorio a mano.

## Resolución de problemas

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| Tras la instalación no aparece la página «Memoria» en los ajustes | DSH sin reiniciar / bundle sin montar | Reinicia el DSH Web Host; con `dsh --profile web --dump-config` comprueba que aparece `dsh-prime-memory` |
| `duplicate loader entry id` al reiniciar | un `insert:` añadido a mano convive con la entrada bundle del mismo id | Elimina la entrada `insert:` añadida manualmente; el paquete ya incluye su propia capa bundle |
| No aparece la línea «Inyección de contexto · memory» | destilación sin ejecutar / recuerdo desactivado | Comprueba que el modo no es off y que `recall.enabled=true`; busca `L1 阶段完成` en `memory.log` |
| La descarga del modelo de embeddings local se queda colgada | el espejo no es accesible en conexión directa | Configura `embedding.proxy` para salir por un proxy; o cambia `embedding.mirror` al oficial `huggingface.co` |
| El embedding remoto da error 401 | apiKey errónea / servicio sin clave al que no hay que enviarla | Revisa `embedding.apiKey`; en un servicio autoalojado sin clave deja apiKey vacía |
| Actualizar cualquier plugin en Windows falla con EPERM / `previous build is incomplete` | El host en ejecución mantiene abiertos `jieba.*.node` / `vec0.dll`, y la re-vinculación de dependencias nativas por pnpm choca con el bloqueo de archivo | Cierra DSH por completo antes de instalar / actualizar (`Get-Process ... -match 'dsh|deepseek|electron'` vacío), instala y reinicia |

Para más información, consulta [README.md](./README.md) y [CHANGELOG.md](./CHANGELOG.md).
