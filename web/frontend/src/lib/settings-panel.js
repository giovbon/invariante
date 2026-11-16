// The settings panel is mostly static markup plus three callbacks. Keeping it
// separate makes the main module's navigation code easier to scan.
export function createSettingsPanel({
    state,
    elements,
    saveMarkers,
    exportBackup,
    importMarkdownNotes,
    defaultTaskMarkers
}) {
function renderSettingsPanel() {
    elements.panelTitle.textContent = 'Configurações';

    const container = document.createElement('div');
    container.className = 'settings-panel';

    const tasksSection = document.createElement('section');
    tasksSection.className = 'settings-section';

    const tasksHeading = document.createElement('h3');
    tasksHeading.textContent = 'Tarefas';

    const tasksDescription = document.createElement('p');
    tasksDescription.className = 'settings-description';
    tasksDescription.textContent = 'Marcadores em MAIÚSCULAS que identificam tarefas no texto, como TODO: e FIXME:. Separe por vírgula. A lista fica salva no servidor e vale para todos os navegadores.';

    const markersLabel = document.createElement('label');
    markersLabel.className = 'sr-only';
    markersLabel.htmlFor = 'taskMarkersInput';
    markersLabel.textContent = 'Marcadores de tarefa';

    const markersInput = document.createElement('input');
    markersInput.type = 'text';
    markersInput.id = 'taskMarkersInput';
    markersInput.className = 'settings-input';
    markersInput.autocomplete = 'off';
    markersInput.spellcheck = false;
    markersInput.value = state.taskMarkers.join(', ');
    markersInput.placeholder = defaultTaskMarkers.join(', ');

    const tasksActions = document.createElement('div');
    tasksActions.className = 'settings-actions';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.id = 'saveTaskMarkers';
    saveButton.className = 'button';
    saveButton.dataset.variant = 'muted';
    saveButton.textContent = 'Salvar marcadores';
    saveButton.addEventListener('click', () => void saveMarkers(markersInput, saveButton));
    markersInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveButton.click();
        }
    });

    const resetMarkers = document.createElement('button');
    resetMarkers.type = 'button';
    resetMarkers.className = 'button';
    resetMarkers.dataset.variant = 'ghost';
    resetMarkers.textContent = 'Restaurar padrão';
    resetMarkers.addEventListener('click', () => {
        markersInput.value = defaultTaskMarkers.join(', ');
        markersInput.removeAttribute('aria-invalid');
        void saveMarkers(markersInput, saveButton);
    });

    tasksActions.append(saveButton, resetMarkers);
    tasksSection.append(tasksHeading, tasksDescription, markersLabel, markersInput, tasksActions);

    const section = document.createElement('section');
    section.className = 'settings-section';

    const markdownHeading = document.createElement('h3');
    markdownHeading.textContent = 'Importar notas Markdown';

    const markdownDescription = document.createElement('p');
    markdownDescription.className = 'settings-description';
    markdownDescription.textContent = 'Selecione vários arquivos .md para criar uma nota na raiz para cada arquivo. O nome do arquivo será usado como título.';

    const markdownActions = document.createElement('div');
    markdownActions.className = 'settings-actions';

    const markdownImportButton = document.createElement('button');
    markdownImportButton.type = 'button';
    markdownImportButton.id = 'importMarkdownNotes';
    markdownImportButton.className = 'button';
    markdownImportButton.dataset.variant = 'muted';
    markdownImportButton.textContent = 'Importar notas Markdown';
    markdownImportButton.addEventListener('click', () => {
        document.querySelector('#markdownImportInput').click();
    });

    markdownActions.append(markdownImportButton);
    section.append(markdownHeading, markdownDescription, markdownActions);
    container.append(section);

    const backupSection = document.createElement('section');
    backupSection.className = 'settings-section';

    const heading = document.createElement('h3');
    heading.textContent = 'Backup';

    const description = document.createElement('p');
    description.className = 'settings-description';
    description.textContent = 'Baixe um arquivo .zip com todas as notas em Markdown organizadas na hierarquia de pastas, além das tags e dos anexos de cada nota.';

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.id = 'exportBackup';
    exportButton.className = 'button';
    exportButton.dataset.variant = 'muted';
    exportButton.textContent = 'Exportar backup';
    exportButton.addEventListener('click', () => void exportBackup(exportButton));

    actions.append(exportButton);
    backupSection.append(heading, description, actions);
    container.append(tasksSection, backupSection);
    elements.panelContent.replaceChildren(container);
}



    return { render: renderSettingsPanel };
}
