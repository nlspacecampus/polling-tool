// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
// Supabase anon (publishable) key is safe to ship in client code.
const SUPABASE_URL = 'https://iofsxaqpwwpktkqncenh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_O7DrxdXr7P7oE75LLbeXlA_8oOPr_RF';

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
const SUPABASE_ENABLED = !!supabase;

// -----------------------------------------------------------------------------
// Local-only fallback storage (used when Supabase is not configured)
// -----------------------------------------------------------------------------
const STORAGE_KEYS = {
  polls: 'polling-tool.polls',
  archive: 'polling-tool.archive',
};

const viewContainer = document.getElementById('view-container');
const homeTemplate = document.getElementById('home-view');
const voteTemplate = document.getElementById('vote-view');
const authTemplate = document.getElementById('auth-view');
let editingPollId = null;
let authUser = null;
let adminAllowed = false;

const isAdmin = () => !!authUser && adminAllowed;

const getRedirectUrl = () => {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
};

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
const getStored = (key, fallback) => {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const setStored = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const generateId = () =>
  `poll_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

const formatDate = (iso) => new Date(iso).toLocaleString();

const setButtonLoading = (button, label, isLoading) => {
  if (!button) return;
  button.disabled = isLoading;
  button.textContent = isLoading ? label.loading : label.idle;
};

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const fetchPolls = () => getStored(STORAGE_KEYS.polls, []);
const savePolls = (polls) => setStored(STORAGE_KEYS.polls, polls);
const fetchArchive = () => getStored(STORAGE_KEYS.archive, []);
const saveArchive = (archive) => setStored(STORAGE_KEYS.archive, archive);

// -----------------------------------------------------------------------------
// Data access
// -----------------------------------------------------------------------------
const listPolls = async (status = 'active') => {
  if (!SUPABASE_ENABLED) return status === 'active' ? fetchPolls() : fetchArchive();
  if (status === 'final' && !isAdmin()) return [];
  const { data, error } = await supabase
    .from('polls')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('Failed to load polls', error.message);
    return [];
  }
  return data || [];
};

const getPollById = async (pollId) => {
  if (!SUPABASE_ENABLED) return fetchPolls().find((entry) => entry.id === pollId) || null;
  const { data, error } = await supabase.from('polls').select('*').eq('id', pollId).maybeSingle();
  if (error) {
    console.warn('Failed to load poll', error.message);
    return null;
  }
  return data;
};

const upsertPoll = async (poll) => {
  if (!SUPABASE_ENABLED) {
    const polls = fetchPolls();
    const index = polls.findIndex((entry) => entry.id === poll.id);
    if (index === -1) polls.push(poll);
    else polls[index] = poll;
    savePolls(polls);
    return;
  }
  const { error } = await supabase.from('polls').upsert(poll);
  if (error) {
    throw new Error(error.message);
  }
};

const listVotes = async (pollId) => {
  if (!SUPABASE_ENABLED) {
    const poll = fetchPolls().find((entry) => entry.id === pollId);
    return poll ? poll.votes || [] : [];
  }
  if (!isAdmin()) return [];
  const { data, error } = await supabase.from('votes').select('*').eq('poll_id', pollId);
  if (error) {
    console.warn('Failed to load votes', error.message);
    return [];
  }
  return data || [];
};

const createVote = async (pollId, answers) => {
  if (!SUPABASE_ENABLED) {
    const polls = fetchPolls();
    const poll = polls.find((entry) => entry.id === pollId);
    if (!poll) return;
    poll.votes.push({ timestamp: new Date().toISOString(), answers });
    savePolls(polls);
    return;
  }
  const { error } = await supabase.rpc('submit_vote', {
    p_poll_id: pollId,
    p_answers: answers,
  });
  if (error) {
    throw new Error(error.message);
  }
};

const fetchPollResults = async (pollId) => {
  if (!SUPABASE_ENABLED) {
    const poll = fetchPolls().find((entry) => entry.id === pollId);
    if (!poll) return null;
    const votes = poll.votes || [];
    return buildAggregateFromVotes(poll, votes);
  }
  const { data, error } = await supabase
    .from('polls')
    .select('results')
    .eq('id', pollId)
    .maybeSingle();
  if (error) {
    console.warn('Failed to load results', error.message);
    return null;
  }
  return data?.results || null;
};

const ensureAdminAccess = async () => {
  if (!SUPABASE_ENABLED || !authUser) {
    adminAllowed = false;
    return false;
  }
  const email = (authUser.email || '').toLowerCase();
  const { data, error } = await supabase
    .from('admin_emails')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  adminAllowed = !!data && !error;
  return adminAllowed;
};

const clearVotes = async (pollId) => {
  if (!SUPABASE_ENABLED) return;
  const { error } = await supabase.from('votes').delete().eq('poll_id', pollId);
  if (error) {
    throw new Error(error.message);
  }
};

const buildPollLink = (id) => {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('poll', id);
  return url.toString();
};

// -----------------------------------------------------------------------------
// Admin (create/edit) view
// -----------------------------------------------------------------------------
const renderHome = async () => {
  viewContainer.innerHTML = '';
  if (SUPABASE_ENABLED && !isAdmin()) {
    viewContainer.appendChild(authTemplate.content.cloneNode(true));
    const authForm = document.getElementById('auth-form');
    const authMessage = document.getElementById('auth-message');
    const signOutButton = document.getElementById('sign-out');
    const authSubmit = document.getElementById('auth-submit');
    if (authUser && !adminAllowed) {
      authMessage.textContent = `Signed in as ${authUser.email}. You are not on the admin allowlist.`;
      if (signOutButton) {
        signOutButton.classList.remove('hidden');
        signOutButton.addEventListener('click', async () => {
          await supabase.auth.signOut();
        });
      }
    }
    authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(authForm);
      const email = formData.get('email').trim();
      if (!email) return;
      try {
        setButtonLoading(authSubmit, { idle: 'Send magic link', loading: 'Sending…' }, true);
        await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: getRedirectUrl() },
        });
        alert('Magic link sent. Check your inbox.');
        authForm.reset();
      } catch (error) {
        alert(`Failed to send magic link: ${error.message}`);
      } finally {
        setButtonLoading(authSubmit, { idle: 'Send magic link', loading: 'Sending…' }, false);
      }
    });
    return;
  }

  viewContainer.appendChild(homeTemplate.content.cloneNode(true));

  const pollForm = document.getElementById('poll-form');
  const questionsContainer = document.getElementById('questions');
  const addQuestionButton = document.getElementById('add-question');
  const submitButton = pollForm.querySelector('button[type="submit"]');
  const editBanner = document.getElementById('edit-banner');
  const cancelEditButton = document.getElementById('cancel-edit');
  const adminEmail = document.getElementById('admin-email');
  const signOutButton = document.getElementById('sign-out');

  const pollList = document.getElementById('poll-list');
  const archiveList = document.getElementById('archive-list');

  const addQuestion = (data = null) => {
    const questionTemplate = document.getElementById('question-card');
    const optionTemplate = document.getElementById('option-row');
    const node = questionTemplate.content.cloneNode(true);
    const wrapper = node.querySelector('div');
    const optionsWrapper = wrapper.querySelector('[data-options]');
    const allowFreeText = wrapper.querySelector('input[name="allowFreeText"]');
    const freeTextLabel = wrapper.querySelector('input[name="freeTextLabel"]');

    const addOptionRow = (value = '') => {
      const optionNode = optionTemplate.content.cloneNode(true);
      const optionRow = optionNode.querySelector('div');
      const input = optionRow.querySelector('input[name="option"]');
      input.value = typeof value === 'string' ? value : '';
      optionRow.querySelector('.remove-option').addEventListener('click', () => {
        optionRow.remove();
      });
      optionsWrapper.appendChild(optionRow);
    };

    wrapper.querySelector('.remove-question').addEventListener('click', () => wrapper.remove());
    wrapper.querySelector('.add-option').addEventListener('click', () => addOptionRow());
    allowFreeText.addEventListener('change', () => {
      freeTextLabel.disabled = !allowFreeText.checked;
      if (!allowFreeText.checked) freeTextLabel.value = '';
    });

    if (data && Array.isArray(data.options)) {
      wrapper.querySelector('input[name="question"]').value = data.prompt;
      wrapper.querySelector('input[name="variable"]').value = data.variable;
      data.options.forEach((option) => addOptionRow(option));
      if (data.allowFreeText) {
        allowFreeText.checked = true;
        freeTextLabel.disabled = false;
        freeTextLabel.value = data.freeTextLabel || 'Other';
      }
    } else {
      addOptionRow();
      addOptionRow();
    }
    questionsContainer.appendChild(wrapper);
  };

  addQuestionButton.addEventListener('click', () => addQuestion());
  addQuestion();

  const resetFormToCreate = () => {
    editingPollId = null;
    pollForm.reset();
    questionsContainer.innerHTML = '';
    addQuestion();
    submitButton.textContent = 'Create poll';
    editBanner.classList.add('hidden');
  };

  const startEdit = (poll) => {
    editingPollId = poll.id;
    pollForm.querySelector('input[name="title"]').value = poll.title;
    pollForm.querySelector('textarea[name="description"]').value = poll.description || '';
    pollForm.querySelector('select[name="type"]').value = poll.type;
    pollForm.querySelector('textarea[name="template"]').value = poll.template || '';
    questionsContainer.innerHTML = '';
    (poll.questions || []).forEach((question) => addQuestion(question));
    submitButton.textContent = 'Save changes';
    editBanner.classList.remove('hidden');
  };

  cancelEditButton.addEventListener('click', resetFormToCreate);

  if (adminEmail) {
    adminEmail.textContent = authUser?.email || 'Signed in';
  }
  if (signOutButton && SUPABASE_ENABLED) {
    signOutButton.addEventListener('click', async () => {
      await supabase.auth.signOut();
    });
  }

  pollForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitLabel = editingPollId ? 'Save changes' : 'Create poll';
    setButtonLoading(submitButton, { idle: submitLabel, loading: 'Saving…' }, true);
    const formData = new FormData(pollForm);
    const title = formData.get('title').trim();
    const description = formData.get('description').trim();
    const type = formData.get('type');
    const template = formData.get('template').trim();

    const questions = Array.from(questionsContainer.children).map((questionNode, index) => {
      const prompt = questionNode.querySelector('input[name="question"]').value.trim();
      const variable = questionNode.querySelector('input[name="variable"]').value.trim();
      const options = Array.from(questionNode.querySelectorAll('input[name="option"]'))
        .map((option) => option.value.trim())
        .filter(Boolean);
      const allowFreeText = questionNode.querySelector('input[name="allowFreeText"]').checked;
      const freeTextLabel = questionNode.querySelector('input[name="freeTextLabel"]').value.trim();

      return {
        id: `q_${index}_${Date.now().toString(36)}`,
        prompt,
        variable,
        options,
        allowFreeText,
        freeTextLabel: allowFreeText && freeTextLabel ? freeTextLabel : 'Other',
      };
    });

    if (!title || questions.length === 0 || questions.some((q) => !q.prompt || !q.variable)) {
      alert('Please fill in all question prompts and variable names.');
      setButtonLoading(submitButton, { idle: submitLabel, loading: 'Saving…' }, false);
      return;
    }

    if (questions.some((q) => q.options.length < 2)) {
      alert('Each question needs at least two options.');
      setButtonLoading(submitButton, { idle: submitLabel, loading: 'Saving…' }, false);
      return;
    }

    if (editingPollId) {
      const existing = await getPollById(editingPollId);
      if (!existing) {
        alert('Poll not found. Please refresh and try again.');
        resetFormToCreate();
        return;
      }
      if (!confirm('Editing will reset existing votes. Continue?')) {
        setButtonLoading(submitButton, { idle: submitLabel, loading: 'Saving…' }, false);
        return;
      }

      const updated = {
        ...existing,
        title,
        description,
        type,
        template,
        questions,
      };
      try {
        await upsertPoll(updated);
        if (SUPABASE_ENABLED) await clearVotes(updated.id);
        renderPollList(pollList, startEdit);
        resetFormToCreate();
        alert('Poll updated. Existing votes were reset.');
        return;
      } catch (error) {
        alert(`Failed to update poll: ${error.message}`);
      } finally {
        setButtonLoading(submitButton, { idle: submitLabel, loading: 'Saving…' }, false);
        return;
      }
    }

    const poll = {
      id: generateId(),
      title,
      description,
      type,
      template,
      questions,
      created_at: new Date().toISOString(),
      status: 'active',
    };

    try {
      await upsertPoll(poll);
      resetFormToCreate();
      renderPollList(pollList, startEdit);
      alert('Poll created. Copy the share link from the list.');
    } catch (error) {
      alert(`Failed to create poll: ${error.message}`);
    } finally {
      setButtonLoading(submitButton, { idle: submitLabel, loading: 'Saving…' }, false);
    }
  });

  await renderPollList(pollList, startEdit);
  await renderArchive(archiveList);
};

// -----------------------------------------------------------------------------
// Admin list + archive
// -----------------------------------------------------------------------------
const summarizePoll = (poll) => {
  const typeLabel =
    poll.type === 'ranking' ? 'Ranking' : poll.type === 'favorite' ? 'Pick favorite' : 'Select one';
  return `${typeLabel} · ${poll.questions.length} question${poll.questions.length === 1 ? '' : 's'}`;
};

const renderPollList = async (container, onEdit = null) => {
  container.innerHTML = '';
  const polls = await listPolls('active');

  if (polls.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-400">No active polls yet.</p>';
    return;
  }

  const cardTemplate = document.getElementById('poll-card');

  polls.forEach((poll) => {
    const card = cardTemplate.content.cloneNode(true);
    const root = card.querySelector('div');
    root.querySelector('[data-title]').textContent = poll.title;
    root.querySelector('[data-meta]').textContent = summarizePoll(poll);

    const link = buildPollLink(poll.id);
    root.querySelector('.copy-link').addEventListener('click', async () => {
      const copied = await copyToClipboard(link);
      if (!copied) {
        window.prompt('Copy this link', link);
        return;
      }
      alert('Poll link copied to clipboard.');
    });

    const resultsPanel = root.querySelector('[data-results]');
    root.querySelector('.view-results').addEventListener('click', async () => {
      resultsPanel.classList.toggle('hidden');
      if (!resultsPanel.classList.contains('hidden')) {
        const votes = await listVotes(poll.id);
        resultsPanel.innerHTML = buildResultsMarkup(poll, votes);
      }
    });

    const editButton = root.querySelector('.edit-poll');
    editButton.addEventListener('click', () => {
      if (onEdit) onEdit(poll);
    });

    root.querySelector('.finalize').addEventListener('click', async () => {
      if (!confirm('Finalize this poll and move it to archive?')) return;
      await finalizePoll(poll.id);
      await renderPollList(container, onEdit);
      await renderArchive(document.getElementById('archive-list'));
    });

    container.appendChild(card);
  });
};

const renderArchive = async (container) => {
  container.innerHTML = '';
  const archive = await listPolls('final');

  if (archive.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500">No archived polls yet.</p>';
    return;
  }

  archive.forEach((entry) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'rounded-2xl border border-white/10 bg-slate-900/60 p-3';
    wrapper.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="text-sm font-semibold text-white">${entry.title}</p>
          <p class="text-xs text-slate-400">Archived ${formatDate(entry.finalized_at)}</p>
        </div>
        <span class="rounded-full bg-slate-700/60 px-2 py-0.5 text-xs text-slate-200">Final</span>
      </div>
      <div class="mt-2 text-xs text-slate-300">${entry.summary}</div>
    `;
    container.appendChild(wrapper);
  });
};

// -----------------------------------------------------------------------------
// Result rendering helpers
// -----------------------------------------------------------------------------
const buildResultsMarkup = (poll, votes = []) => {
  if (!votes || votes.length === 0) {
    return '<p>No votes yet.</p>';
  }

  const fragments = (poll.questions || []).map((question) => {
    const votesForQuestion = votes.map((vote) => vote.answers[question.id]);

    if (poll.type === 'ranking') {
      const scores = {};
      question.options.forEach((option) => (scores[option] = 0));
      votesForQuestion.forEach((ranking) => {
        if (!Array.isArray(ranking)) return;
        const total = ranking.length;
        ranking.forEach((option, index) => {
          scores[option] += total - index;
        });
      });
      const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

      return `
        <div class="mt-3">
          <p class="font-semibold text-white">${question.prompt}</p>
          ${ranked
            .map(
              ([option, score]) =>
                `<div class="mt-1 flex items-center justify-between">
                  <span>${option}</span>
                  <span class="text-cyan-200">${score} pts</span>
                </div>`
            )
            .join('')}
        </div>
      `;
    }

    const counts = {};
    question.options.forEach((option) => (counts[option] = 0));
    const freeTextValues = [];
    votesForQuestion.forEach((choice) => {
      if (choice && typeof choice === 'object' && choice.type === 'free') {
        freeTextValues.push(choice.value);
        return;
      }
      if (counts[choice] !== undefined) counts[choice] += 1;
    });
    if (question.allowFreeText && freeTextValues.length > 0) {
      counts[question.freeTextLabel || 'Other'] = freeTextValues.length;
    }
    const totalVotes = votes.length || 1;

    return `
      <div class="mt-3">
        <p class="font-semibold text-white">${question.prompt}</p>
        ${Object.entries(counts)
          .map(([option, count]) => {
            const percent = Math.round((count / totalVotes) * 100);
            const extras =
              question.allowFreeText && option === (question.freeTextLabel || 'Other')
                ? `<div class="mt-1 text-xs text-slate-400">${freeTextValues
                    .slice(0, 3)
                    .map((value) => `“${value}”`)
                    .join(', ')}${freeTextValues.length > 3 ? '…' : ''}</div>`
                : '';
            return `
              <div class="mt-1">
                <div class="flex items-center justify-between">
                  <span>${option}</span>
                  <span class="text-cyan-200">${count} (${percent}%)</span>
                </div>
                <div class="mt-1 h-1.5 rounded-full bg-slate-800">
                  <div class="h-1.5 rounded-full bg-cyan-500" style="width: ${percent}%"></div>
                </div>
                ${extras}
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  });

  return fragments.join('');
};

const buildAggregateMarkup = (poll, aggregate) => {
  if (!aggregate || !aggregate.questions || aggregate.questions.length === 0) {
    return '<p>No votes yet.</p>';
  }
  const fragments = aggregate.questions.map((question) => {
    const isRanking = aggregate.type === 'ranking';
    const totalVotes = question.total || 1;
    const maxScore = isRanking
      ? Math.max(1, ...question.options.map((option) => option.score || 0))
      : totalVotes;
    return `
      <div class="mt-3">
        <p class="font-semibold text-white">${question.prompt}</p>
        ${question.options
          .map((option) => {
            const value = isRanking ? option.score || 0 : option.count || 0;
            const percent = Math.round((value / (isRanking ? maxScore : totalVotes)) * 100);
            const suffix = isRanking ? ' pts' : ` (${percent}%)`;
            return `
              <div class="mt-1">
                <div class="flex items-center justify-between">
                  <span>${option.label}</span>
                  <span class="text-cyan-200">${value}${suffix}</span>
                </div>
                <div class="mt-1 h-1.5 rounded-full bg-slate-800">
                  <div class="h-1.5 rounded-full bg-cyan-500" style="width: ${percent}%"></div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  });
  return fragments.join('');
};

const buildAggregateFromVotes = (poll, votes) => {
  const questions = (poll.questions || []).map((question) => {
    const total = votes.length;
    if (poll.type === 'ranking') {
      const scores = {};
      question.options.forEach((option) => (scores[option] = 0));
      votes.forEach((vote) => {
        const ranking = vote.answers[question.id];
        if (!Array.isArray(ranking)) return;
        const weight = ranking.length;
        ranking.forEach((option, index) => {
          scores[option] += weight - index;
        });
      });
      return {
        id: question.id,
        prompt: question.prompt,
        total,
        options: Object.entries(scores).map(([label, score]) => ({ label, score })),
      };
    }

    const counts = {};
    question.options.forEach((option) => (counts[option] = 0));
    let freeTextCount = 0;
    votes.forEach((vote) => {
      const choice = vote.answers[question.id];
      if (choice && typeof choice === 'object' && choice.type === 'free') {
        freeTextCount += 1;
        return;
      }
      if (counts[choice] !== undefined) counts[choice] += 1;
    });
    if (question.allowFreeText && freeTextCount > 0) {
      counts[question.freeTextLabel || 'Other'] = freeTextCount;
    }
    return {
      id: question.id,
      prompt: question.prompt,
      total,
      options: Object.entries(counts).map(([label, count]) => ({ label, count })),
    };
  });

  return { type: poll.type, questions };
};

const finalizePoll = async (pollId) => {
  const poll = await getPollById(pollId);
  if (!poll) return;
  const votes = await listVotes(pollId);

  const summary = (poll.questions || [])
    .map((question) => {
      if (!votes || votes.length === 0) return `${question.prompt}: No votes`;
      if (poll.type === 'ranking') {
        const scores = {};
        question.options.forEach((option) => (scores[option] = 0));
        votes.forEach((vote) => {
          const ranking = vote.answers[question.id];
          if (!Array.isArray(ranking)) return;
          ranking.forEach((option, index) => {
            scores[option] += ranking.length - index;
          });
        });
        const [top] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        return `${question.prompt}: ${top ? top[0] : 'No votes'}`;
      }
      const counts = {};
      question.options.forEach((option) => (counts[option] = 0));
      let freeTextCount = 0;
      votes.forEach((vote) => {
        const choice = vote.answers[question.id];
        if (choice && typeof choice === 'object' && choice.type === 'free') {
          freeTextCount += 1;
          return;
        }
        if (counts[choice] !== undefined) counts[choice] += 1;
      });
      if (question.allowFreeText && freeTextCount > 0) {
        counts[question.freeTextLabel || 'Other'] = freeTextCount;
      }
      const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      return `${question.prompt}: ${top ? top[0] : 'No votes'}`;
    })
    .join(' · ');

  if (!supabase) {
    const polls = fetchPolls();
    const pollIndex = polls.findIndex((entry) => entry.id === pollId);
    if (pollIndex !== -1) {
      polls.splice(pollIndex, 1);
      savePolls(polls);
    }
    const archive = fetchArchive();
    archive.unshift({
      ...poll,
      status: 'final',
      finalized_at: new Date().toISOString(),
      summary,
    });
    saveArchive(archive);
    return;
  }

  await supabase
    .from('polls')
    .update({
      status: 'final',
      finalized_at: new Date().toISOString(),
      summary,
    })
    .eq('id', pollId);
};

// -----------------------------------------------------------------------------
// Vote view
// -----------------------------------------------------------------------------
const renderVote = async (pollId) => {
  const poll = await getPollById(pollId);

  viewContainer.innerHTML = '';
  viewContainer.appendChild(voteTemplate.content.cloneNode(true));

  const titleEl = document.getElementById('poll-title');
  const descEl = document.getElementById('poll-description');
  const formEl = document.getElementById('vote-form');
  const templatePreview = document.getElementById('template-preview');
  const submitButton = document.getElementById('submit-vote');
  const toggleResults = document.getElementById('toggle-results');
  const publicResults = document.getElementById('public-results');

  if (!poll || poll.status === 'final') {
    titleEl.textContent = 'Poll not found';
    descEl.textContent = 'This poll was removed or archived.';
    submitButton.disabled = true;
    submitButton.classList.add('opacity-50', 'cursor-not-allowed');
    return;
  }

  titleEl.textContent = poll.title;
  descEl.textContent = poll.description || 'This poll has no description.';

  const responseState = {};

  const updateRanking = (question, wrapper) => {
    const selections = Array.from(wrapper.querySelectorAll('[data-rank]'))
      .map((select) => ({
        option: select.parentElement.dataset.option,
        rank: Number(select.value),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.option);

    responseState[question.id] = selections;
    refreshTemplate();
  };

  const refreshTemplate = () => {
    const variables = poll.questions.reduce((acc, question) => {
      const answer = responseState[question.id];
      if (poll.type === 'ranking') {
        acc[question.variable] = Array.isArray(answer) ? answer.join(' > ') : '';
      } else if (answer && typeof answer === 'object' && answer.type === 'free') {
        acc[question.variable] = answer.value || '';
      } else {
        acc[question.variable] = answer || '';
      }
      return acc;
    }, {});

    if (!poll.template) {
      templatePreview.textContent = 'Add a template string to preview combined answers.';
      return;
    }

    const preview = poll.template.replace(/\{(.*?)\}/g, (_, key) => variables[key.trim()] || '');
    templatePreview.textContent = preview || 'Make a selection to preview the template.';
  };

  (poll.questions || []).forEach((question) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4';
    wrapper.innerHTML = `
      <div>
        <p class="text-xs uppercase tracking-widest text-slate-400">Question</p>
        <p class="mt-1 text-sm font-semibold text-white">${question.prompt}</p>
      </div>
    `;

    if (poll.type === 'ranking') {
      const helper = document.createElement('p');
      helper.className = 'text-xs text-slate-400';
      helper.textContent = 'Assign a unique rank to each option.';
      wrapper.appendChild(helper);

      question.options.forEach((option, index) => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-3';
        row.innerHTML = `
          <span class="text-sm text-slate-200">${option}</span>
          <select
            class="rounded-xl border border-white/10 bg-slate-900/60 px-2 py-1 text-xs text-white"
            data-rank
          >
            ${question.options
              .map((_, rankIndex) => `<option value="${rankIndex + 1}">${rankIndex + 1}</option>`)
              .join('')}
          </select>
        `;
        const select = row.querySelector('select');
        select.value = index + 1;
        select.addEventListener('change', () => updateRanking(question, wrapper));
        row.dataset.option = option;
        wrapper.appendChild(row);
      });

      updateRanking(question, wrapper);
    } else {
      let freeRadio = null;
      let freeInput = null;
      const clearFreeText = () => {
        if (!freeInput || !freeRadio) return;
        freeInput.disabled = true;
        freeInput.value = '';
        freeRadio.checked = false;
      };

      question.options.forEach((option) => {
        const label = document.createElement('label');
        label.className = 'flex items-center gap-3 text-sm text-slate-200';
        label.innerHTML = `
          <input type="radio" name="${question.id}" value="${option}" class="h-4 w-4" />
          <span>${option}</span>
        `;
        const input = label.querySelector('input');
        input.addEventListener('change', () => {
          clearFreeText();
          responseState[question.id] = option;
          refreshTemplate();
        });
        wrapper.appendChild(label);
      });

      if (question.allowFreeText) {
        const freeRow = document.createElement('div');
        freeRow.className = 'mt-1 grid gap-2';
        freeRow.innerHTML = `
          <label class="flex items-center gap-3 text-sm text-slate-200">
            <input type="radio" name="${question.id}" value="__free_text__" class="h-4 w-4" />
            <span>${question.freeTextLabel || 'Other'}</span>
          </label>
          <input
            type="text"
            class="w-full rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white"
            placeholder="Type your answer"
            disabled
          />
        `;
        freeRadio = freeRow.querySelector('input[type="radio"]');
        freeInput = freeRow.querySelector('input[type="text"]');

        freeRadio.addEventListener('change', () => {
          if (freeRadio.checked) {
            freeInput.disabled = false;
            freeInput.focus();
            responseState[question.id] = { type: 'free', value: freeInput.value.trim() };
          }
          refreshTemplate();
        });

        freeInput.addEventListener('input', () => {
          if (!freeRadio.checked) return;
          responseState[question.id] = { type: 'free', value: freeInput.value.trim() };
          refreshTemplate();
        });

        wrapper.appendChild(freeRow);
      }
    }

    formEl.appendChild(wrapper);
  });

  refreshTemplate();

  if (toggleResults && publicResults) {
    toggleResults.addEventListener('click', async () => {
      publicResults.classList.toggle('hidden');
      if (!publicResults.classList.contains('hidden')) {
        publicResults.innerHTML = '<p>Loading results…</p>';
        const aggregate = await fetchPollResults(poll.id);
        publicResults.innerHTML = buildAggregateMarkup(poll, aggregate);
      }
    });
  }

  submitButton.addEventListener('click', async () => {
    setButtonLoading(submitButton, { idle: 'Submit vote', loading: 'Submitting…' }, true);
    if (poll.type === 'ranking') {
      const invalid = poll.questions.some((question) => {
        const answers = responseState[question.id];
        return !answers || answers.length !== question.options.length;
      });
      if (invalid) {
        alert('Please rank every option before submitting.');
        setButtonLoading(submitButton, { idle: 'Submit vote', loading: 'Submitting…' }, false);
        return;
      }
    } else {
      const missing = poll.questions.some((question) => !responseState[question.id]);
      if (missing) {
        const message =
          poll.type === 'favorite'
            ? 'Please select one favorite for each question.'
            : 'Please select one answer for each question.';
        alert(message);
        setButtonLoading(submitButton, { idle: 'Submit vote', loading: 'Submitting…' }, false);
        return;
      }
      const emptyFreeText = poll.questions.some((question) => {
        const answer = responseState[question.id];
        return question.allowFreeText && answer && answer.type === 'free' && !answer.value;
      });
      if (emptyFreeText) {
        alert('Please type your free text answer before submitting.');
        setButtonLoading(submitButton, { idle: 'Submit vote', loading: 'Submitting…' }, false);
        return;
      }
    }

    try {
      await createVote(poll.id, responseState);
      if (publicResults && !publicResults.classList.contains('hidden')) {
        publicResults.innerHTML = '<p>Loading results…</p>';
        const aggregate = await fetchPollResults(poll.id);
        publicResults.innerHTML = buildAggregateMarkup(poll, aggregate);
      }
      alert('Thanks! Your vote has been recorded.');
      window.location.href = './index.html';
    } catch (error) {
      alert(`Failed to submit vote: ${error.message}`);
    } finally {
      setButtonLoading(submitButton, { idle: 'Submit vote', loading: 'Submitting…' }, false);
    }
  });
};

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
const init = async () => {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    authUser = data?.session?.user || null;
    await ensureAdminAccess();
    supabase.auth.onAuthStateChange((_event, session) => {
      authUser = session?.user || null;
      ensureAdminAccess().then(() => {
        const params = new URLSearchParams(window.location.search);
        const pollId = params.get('poll');
        if (!pollId) renderHome();
      });
    });
  }

  const params = new URLSearchParams(window.location.search);
  const pollId = params.get('poll');

  if (pollId) {
    await renderVote(pollId);
  } else {
    await renderHome();
  }
};

window.addEventListener('load', init);
