// The settings panel is mostly static markup plus three callbacks. Keeping it
// separate makes the main module's navigation code easier to scan.
export function createSettingsPanel({
    state,
    elements,
    requestJSON,
    showMessage,
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

    const agendaSection = createAgendaSettingsSection();
    container.append(tasksSection, agendaSection, section, backupSection);
    elements.panelContent.replaceChildren(container);
}

function settingsField(labelText, control, hintText = '') {
    const label = document.createElement('label');
    label.className = 'settings-field';
    const caption = document.createElement('span');
    caption.textContent = labelText;
    label.append(caption, control);
    if (hintText) {
        const hint = document.createElement('small');
        hint.textContent = hintText;
        label.append(hint);
    }
    return label;
}

function settingsCheck(labelText, control) {
    const label = document.createElement('label');
    label.className = 'settings-check';
    const caption = document.createElement('span');
    caption.textContent = labelText;
    label.append(control, caption);
    return label;
}

// Agenda notifications read the ntfy destination from the environment:
// AGENDA_NTFY_TOPIC plus the NTFY_* server and credentials shared with the
// capture feature. Only the reminder schedule lives in the database.
function createAgendaSettingsSection() {
    const section = document.createElement('section');
    section.className = 'settings-section';

    const heading = document.createElement('h3');
    heading.textContent = 'Agenda e avisos';

    const description = document.createElement('p');
    description.className = 'settings-description';
    description.textContent = 'Envie lembretes por ntfy um dia antes de cada compromisso e um resumo no começo da semana. O servidor e as credenciais são os mesmos da captura de notas; basta definir AGENDA_NTFY_TOPIC no docker-compose.';

    const status = document.createElement('p');
    status.className = 'settings-description agenda-settings-status';
    status.textContent = 'Carregando…';

    const hours = document.createElement('input');
    hours.type = 'number';
    hours.id = 'agendaReminderHours';
    hours.className = 'settings-input';
    hours.min = '1';
    hours.max = '168';
    hours.step = '1';

    const weeklyEnabled = document.createElement('input');
    weeklyEnabled.type = 'checkbox';
    weeklyEnabled.id = 'agendaWeeklyEnabled';
    const weeklyField = settingsCheck('Enviar resumo semanal', weeklyEnabled);

    const weeklyDay = document.createElement('select');
    weeklyDay.id = 'agendaWeeklyDay';
    weeklyDay.className = 'settings-input';
    const weekdays = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
    weekdays.forEach((name, index) => {
        const option = document.createElement('option');
        option.value = String(index + 1);
        option.textContent = name;
        weeklyDay.append(option);
    });

    const weeklyHour = document.createElement('input');
    weeklyHour.type = 'number';
    weeklyHour.id = 'agendaWeeklyHour';
    weeklyHour.className = 'settings-input';
    weeklyHour.min = '0';
    weeklyHour.max = '23';
    weeklyHour.step = '1';

    const timezone = document.createElement('input');
    timezone.type = 'text';
    timezone.id = 'agendaTimezone';
    timezone.className = 'settings-input';
    timezone.autocomplete = 'off';
    timezone.spellcheck = false;
    timezone.placeholder = 'America/Sao_Paulo';

    const grid = document.createElement('div');
    grid.className = 'agenda-settings-form';
    grid.append(
        settingsField('Aviso antecipado (horas)', hours, 'Padrão: 24 horas antes do compromisso.'),
        weeklyField,
        settingsField('Dia do resumo', weeklyDay),
        settingsField('Hora do resumo', weeklyHour),
        settingsField('Fuso horário', timezone, 'Ex.: America/Sao_Paulo. Vale para o resumo semanal.')
    );

    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'button';
    saveButton.dataset.variant = 'muted';
    saveButton.textContent = 'Salvar agenda';
    saveButton.disabled = true;
    actions.append(saveButton);

    const controls = [hours, weeklyEnabled, weeklyDay, weeklyHour, timezone];

    function fill(settings) {
        hours.value = String(settings.reminder_hours ?? 24);
        weeklyEnabled.checked = Boolean(settings.weekly_enabled);
        weeklyDay.value = String(settings.weekly_day ?? 1);
        weeklyHour.value = String(settings.weekly_hour ?? 8);
        timezone.value = settings.timezone || '';
        if (settings.ntfy_error) {
            status.textContent = `Configuração do ntfy inválida: ${settings.ntfy_error}`;
        } else if (settings.ntfy_configured) {
            status.textContent = `Avisos ativos para o tópico "${settings.ntfy_topic}" (definido em AGENDA_NTFY_TOPIC).`;
        } else {
            status.textContent = 'Avisos desativados. Defina AGENDA_NTFY_TOPIC no docker-compose para ativar.';
        }
    }

    async function loadSettings() {
        try {
            const settings = await requestJSON('/api/agenda-settings');
            fill(settings || {});
            saveButton.disabled = false;
        } catch (failure) {
            status.textContent = `Não foi possível carregar as configurações da agenda: ${failure.message}`;
        }
    }

    saveButton.addEventListener('click', async () => {
        for (const control of controls) control.disabled = true;
        saveButton.disabled = true;
        try {
            const saved = await requestJSON('/api/agenda-settings', {
                method: 'PUT',
                body: JSON.stringify({
                    reminder_hours: Number(hours.value),
                    weekly_enabled: weeklyEnabled.checked,
                    weekly_day: Number(weeklyDay.value),
                    weekly_hour: Number(weeklyHour.value),
                    timezone: timezone.value.trim()
                })
            });
            fill(saved || {});
            showMessage('Configurações da agenda salvas.', 'success');
        } catch (failure) {
            showMessage(`Não foi possível salvar a agenda: ${failure.message}`, 'error');
        } finally {
            for (const control of controls) control.disabled = false;
            saveButton.disabled = false;
        }
    });

    section.append(heading, description, status, grid, actions);
    void loadSettings();
    return section;
}



    return { render: renderSettingsPanel };
}
