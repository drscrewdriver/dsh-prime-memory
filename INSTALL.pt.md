# Guia de instalação (dsh-prime-memory)

Este plugin é distribuído como **bundle oficial do DSH**: depois da instalação, a camada `dsh.bundle` do `cordis.patch.yml` monta automaticamente a entrada do plugin; não é preciso editar nenhum perfil manualmente.

## Requisitos

- Node.js ≥ 22.16 (DSH 0.2.0-rc.1 ou superior)
- DeepSeek Harness (a partir daqui, DSH) instalado, com `--profile web` disponível

## Instalação

Escolha o modo de chamada preferido (o prefixo `npx` pode substituir `dsh` em qualquer um dos comandos abaixo):

> Os comandos a seguir valem apenas para o host CLI do DSH e `--profile web*; **usuários do DSH Desktop (Electron) não precisam de pnpm/npm** — o perfil de desktop é gerido exclusivamente pelo aplicativo; instale este plugin pela página de plugins do app.

```bash
# Modo 1: executar a CLI oficial direto com npx (não exige dsh pré-instalado; dá para fixar a versão, ex. dsh-prime-memory@0.8.4)
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# Modo 2: com a CLI dsh já instalada (dsh é um encaminhador do pnpm; se não tiver pnpm, antes: npm i -g pnpm)
dsh plugin --profile web add dsh-prime-memory

# Fontes alternativas do pacote: repositório GitHub / caminho local (desenvolvimento e depuração; link: aponta para o repositório, basta npm run build + reiniciar o dsh)
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Deixe o agente instalar (recomendado)

Envie a mensagem abaixo ao agente atual (desde que ele consiga executar comandos de terminal):

```text
Instale o plugin dsh-prime-memory para o perfil web do DeepSeek Harness.

Execute apenas os dois comandos a seguir e não modifique outros perfis:
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

Quando dsh-prime-memory aparecer na saída, me informe o resultado da instalação.
Não feche nem reinicie por conta própria o DSH em execução; ao terminar a instalação, me lembre de reiniciar manualmente o DSH Web Host.
```

## Atualização

```bash
# Atualizar para a última versão
dsh plugin --profile web update dsh-prime-memory

# Atualizar para uma versão específica
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

A atualização só substitui o código do plugin e os artefatos de `dist/`; o diretório de dados `~/.dsh/memory/` não é afetado.

## Windows: feche o runtime do DSH antes de instalar / atualizar

No Windows, com o host desktop do DSH em execução, instalar / atualizar **qualquer** plugin pela página de plugins pode fazer o pnpm (distribuição hoisted) re-vincular toda a árvore `node_modules` de primeiro nível e renomear as dependências nativas deste plugin, `@node-rs/jieba` / `sqlite-vec`, para colocar cópias novas. O host mantém `jieba.*.node` / `vec0.dll` abertos, e o Windows aplica trava exclusiva sobre imagens carregadas, então o renomeio falha e a atualização é revertida (EPERM, reportado como `previous build is incomplete`).

Solução: **feche o DSH por completo antes de rodar pnpm / `dsh plugin add|update`**, confirme que não sobrou nenhum processo, instale e depois reinicie:

```powershell
# deve retornar vazio antes de instalar / atualizar
Get-Process | Where-Object { $_.ProcessName -match 'dsh|deepseek|electron' }
```

Não é falha do plugin: a origem é o fluxo de atualização de plugins do host somado às travas de arquivo do Windows; fechar o runtime libera a trava e vale para atualizar qualquer plugin.

## Verificação

Depois de instalar e reiniciar o DSH Web Host, confira:

1. **O diretório de dados aparece** — o plugin foi aplicado com sucesso: em `~/.dsh/memory/` surgem os diretórios `conversations/`, `records/`, `scenes/` e o arquivo `memory.db`;
2. **A página «Memória» aparece nos ajustes** e a pílula de modo aparece na barra de entrada — a metade client está pronta;
3. Envie uma mensagem com informação pessoal, espere a destilação terminar e pergunte sobre ela em outro turno de conversa: no contexto deve aparecer a linha «Injeção de contexto · memory».

Smoke test opcional (desenvolvimento/diagnóstico):

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## Migração / volta à versão antiga

- **Migrar da versão antiga (antes de 0.5.0 chamava-se `dsh-memory-plugin`)**: o diretório de dados antigo é incompatível com o pacote novo; faça backup e apague `~/.dsh/memory/`, o plugin novo o reconstrói na primeira inicialização. As memórias existentes não podem ser atualizadas diretamente: é preciso destilá-las de novo.
- **Voltar à versão antiga**: depois de `dsh plugin --profile web remove dsh-prime-memory`, reinstale seguindo a documentação da versão antiga; o diretório de dados é preservado, mas a versão antiga não reconhece a estrutura nova — é recomendável limpá-lo.

## Desinstalação

```bash
dsh plugin --profile web remove dsh-prime-memory
```

Os dados permanecem em `~/.dsh/memory/`; se não precisar mais deles, apague o diretório inteiro manualmente.

## Solução de problemas

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| Após a instalação, a página «Memória» não aparece nos ajustes | DSH sem reiniciar / bundle sem montar | Reinicie o DSH Web Host; com `dsh --profile web --dump-config` confira que `dsh-prime-memory` aparece |
| `duplicate loader entry id` ao reiniciar | um `insert:` adicionado manualmente convive com a entrada bundle do mesmo id | Remova a entrada `insert:` adicionada à mão; o pacote já traz sua própria camada bundle |
| A linha «Injeção de contexto · memory» não aparece | destilação sem rodar / recordação desativada | Confira que o modo não é off e que `recall.enabled=true`; procure `L1 阶段完成` em `memory.log` |
| O download do modelo de embeddings local trava | o espelho não é acessível em conexão direta | Configure `embedding.proxy` para sair por um proxy; ou troque `embedding.mirror` para o oficial `huggingface.co` |
| O embedding remoto retorna erro 401 | apiKey errada / serviço sem chave ao qual não se deve enviar chave | Verifique `embedding.apiKey`; num serviço auto-hospedado sem chave, deixe apiKey vazia |
| Atualizar qualquer plugin no Windows falha com EPERM / `previous build is incomplete` | O host em execução mantém `jieba.*.node` / `vec0.dll` abertos, e a re-vinculação das dependências nativas pelo pnpm esbarra na trava de arquivo | Feche o DSH por completo antes de instalar / atualizar (`Get-Process ... -match 'dsh|deepseek|electron'` vazio), instale e reinicie |

Para mais informações, consulte [README.pt.md](./README.pt.md) e [CHANGELOG.pt.md](./CHANGELOG.pt.md).
