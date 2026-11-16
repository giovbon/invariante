# Central de ajuda

O **TON-618** guarda suas notas Markdown em um banco SQLite local. As pastas são caminhos virtuais no banco — o aplicativo não cria arquivos `.md` no disco. Este arquivo fica na raiz do projeto e é exibido pelo botão **?** da barra superior.

## Interface

- A barra lateral esquerda reúne pastas, backlinks, sumário, tarefas, grafo e configurações.
- A barra superior tem a busca/paleta de comandos, esta ajuda, a criação de notas e, no editor, anexos e exclusão.
- A busca filtra por título, conteúdo ou tabela. O atalho `/` foca a busca quando você está na lista.
- **Ctrl/Cmd+K** abre a paleta de comandos, que também busca notas e executa ações.
- **Ctrl/Cmd+N** cria uma nota.

## Pastas e notas

- Crie notas e pastas pelos ícones ao lado de “Todas as notas”.
- Arraste notas e pastas para reorganizá-las. `Shift+clique` seleciona um intervalo; `Ctrl/Cmd+clique` adiciona ou remove itens da seleção.
- Com várias notas selecionadas, arraste para mover todas juntas ou pressione `Delete` para excluí-las após confirmação.
- Ao renomear uma nota, os links de entrada que apontavam para o título antigo são atualizados.
- `hide_from_explorer: true` no frontmatter mantém a nota fora da árvore, sem removê-la da busca e do grafo.

## Editor

- O salvamento é automático. Duas abas não sobrescrevem uma à outra: se outra sessão alterou a nota, o servidor responde com conflito e o app avisa.
- Modos: **Edição**, **Dividido** e **Leitura**. `Ctrl/Cmd+Alt+1/2/3` escolhe o modo e `Ctrl/Cmd+Alt+V` alterna.
- Formatação: `Ctrl/Cmd+B` (negrito), `Ctrl/Cmd+I` (itálico), `Ctrl/Cmd+K` na paleta, `Ctrl/Cmd+Alt+T` (tabela).
- O divisor entre edição e pré-visualização pode ser arrastado.
- A pré-visualização é renderizada no servidor com Goldmark. HTML bruto permanece inativo e links com esquemas inseguros são neutralizados.

## Atalhos de digitação

Digite no começo de uma palavra e pressione `Tab` para expandir na hora:

| Atalho | Resultado |
| --- | --- |
| `;hoje` | data atual em ISO (`2026-11-16`) |
| `;data` | data atual em `dd/mm/aaaa` |
| `;hora` | hora e minuto atuais |
| `;dia` | dia da semana e data |
| `;amanha` / `;ontem` | datas relativas em ISO |
| `;tabela3x4` | tabela com 3 colunas e 4 linhas de corpo |

## Tags e frontmatter

- Tags são lidas do frontmatter YAML (`tags: projeto, ideia` ou uma lista).
- Clique em uma tag nos cards ou na barra de filtros para listar as notas com aquela tag.
- `note-type: markmap` transforma a pré-visualização em um mapa mental interativo.

## Links e relações

- Wikilinks: `[[Título]]`, `[[Título|alias]]`, `[[Pasta/Título]]`, `[[Título#seção]]` e `[[#seção]]` para a própria nota.
- Ao digitar `[[`, o autocomplete sugere notas e, depois de `#`, os cabeçalhos da nota.
- Backlinks e grafo são calculados a partir de links Markdown e wikilinks.
- Mover uma nota ou pasta recalcula os links relativos e acompanha os caminhos absolutos.

## Blocos dinâmicos

Comentários `<!-- ton618:... -->` sozinhos na linha geram conteúdo a partir do banco:

| Bloco | Conteúdo |
| --- | --- |
| `<!-- ton618:tasks -->` | linhas com marcadores de tarefa |
| `<!-- ton618:backlinks -->` | notas que apontam para esta |
| `<!-- ton618:recentes -->` | últimas notas alteradas |
| `<!-- ton618:toc -->` | índice dos cabeçalhos |
| `<!-- ton618:links -->` | links de saída da nota |
| `<!-- ton618:tabela -->` | tabela de notas com filtros |

Cada bloco aceita até 50 itens e a nota aceita até 20 blocos. `backlinks` e `links` exigem uma nota salva.

## Tarefas

- O painel **Tarefas** encontra marcadores como `TODO:`, `FIXME:` e `BUG:` em todas as notas.
- Clique em um resultado para abrir a nota na linha correspondente.
- Configure os marcadores em **Configurações → Tarefas**.

## Tabela

- O modo **Tabela** da busca mostra título, pasta, atualização e as propriedades do frontmatter.
- O ícone de colunas permite escolher quais propriedades exibir; a escolha fica salva no navegador.

## Anexos

- Envie arquivos pelo botão de anexos no editor (limite de 25 MiB por arquivo).
- Imagens compatíveis entram como `![nome](URL)`; outros arquivos entram como links Markdown.
- Os arquivos ficam em `attachments/<id-da-nota>/` no diretório de dados.

## Backup

- **Configurações → Backup** exporta um `.zip` com notas, pastas, tags, vínculos e anexos.
- A restauração é tudo ou nada: um arquivo inválido não altera os dados existentes.
- Para uma cópia manual, pare o servidor e copie `notes.db` e a pasta `attachments/` juntos.

## Personalizando esta ajuda

Edite o arquivo `HELP.md` na raiz do projeto. O botão **?** relê o arquivo a cada abertura, sem precisar reiniciar o servidor.
