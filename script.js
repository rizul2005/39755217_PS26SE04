/*
  Ledger — starter anomaly detection logic.
  Everything runs client-side: no data leaves the browser.

  Detection approach (v0, to be extended):
  1. Parse CSV into { date, description, amount } rows.
  2. Bucket transactions by a rough category (keyword match on description).
  3. Within each category, flag amounts that are statistical outliers (z-score).
  4. Separately, track descriptions that repeat (recurring charges) and flag
     if the amount changes between occurrences — this catches subscription
     price creep even when the amount itself isn't a big outlier.
*/

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const resultsSection = document.getElementById('results');
const emptyState = document.getElementById('emptyState');
const ledgerTable = document.getElementById('ledgerTable');
const resultsSummary = document.getElementById('resultsSummary');
const resultsTitle = document.getElementById('resultsTitle');
const toggleFlagged = document.getElementById('toggleFlagged');
const toggleAll = document.getElementById('toggleAll');

const CATEGORY_KEYWORDS = {
  subscriptions: ['netflix', 'spotify', 'prime', 'subscription', 'membership', 'gym', 'icloud', 'adobe'],
  food: ['restaurant', 'cafe', 'coffee', 'grocery', 'market', 'uber eats', 'doordash'],
  transport: ['uber', 'lyft', 'transit', 'fuel', 'gas station', 'parking'],
  shopping: ['amazon', 'store', 'shop', 'retail'],
};

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.csv')) {
    showError('That file isn\'t a CSV. Export your statement as CSV and try again.');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showError('That file is larger than 5MB — check it\'s a statement export, not something else.');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => runDetection(reader.result);
  reader.onerror = () => showError('Couldn\'t read that file. Try re-exporting it and uploading again.');
  reader.readAsText(file);
}

function showError(message) {
  resultsSection.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector('p').textContent = message;
}

// Splits one CSV line into fields, respecting double-quoted fields that may
// themselves contain commas (e.g. "Whole Foods, Inc.,-84.20" should NOT be
// split on the comma inside the quotes). A plain line.split(',') would break
// on any statement export that quotes merchant names like this.
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote ("") inside a quoted field means a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const dateIdx = header.findIndex(h => h.includes('date'));
  const descIdx = header.findIndex(h => h.includes('desc'));
  const amountIdx = header.findIndex(h => h.includes('amount'));

  if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) return [];

  return lines.slice(1).map(line => {
    const cols = parseCSVLine(line);
    // Skip malformed rows (wrong number of fields) instead of crashing or
    // silently misreading them.
    if (cols.length <= Math.max(dateIdx, descIdx, amountIdx)) return null;

    const amount = parseFloat((cols[amountIdx] || '').replace(/[^0-9.-]/g, ''));
    return {
      date: (cols[dateIdx] || '').trim(),
      description: (cols[descIdx] || '').trim(),
      amount: isNaN(amount) ? null : amount,
    };
  }).filter(row => row && row.description && row.amount !== null);
}

function categorize(description) {
  const lower = description.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return 'other';
}

function zScoreFlags(rows) {
  const spendingOnly = rows.filter(row => row.amount < 0); // only look at money going OUT, not incoming transfers

  const byCategory = {};
  spendingOnly.forEach(row => {
    row.category = categorize(row.description);
    (byCategory[row.category] ||= []).push(row);
  });


  const flagged = [];
  Object.values(byCategory).forEach(group => {
    if (group.length < 3) return; // not enough data to judge "normal" for this category
    const amounts = group.map(r => Math.abs(r.amount));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length;
    const stdDev = Math.sqrt(variance) || 1;

    group.forEach(row => {
      const z = (Math.abs(row.amount) - mean) / stdDev;
      if (z > 2) {
        flagged.push({
          ...row,
          reason: `${Math.abs(row.amount).toFixed(2)} is well above your typical ${row.category} spend (avg €${mean.toFixed(2)})`,
          severity: z > 3 ? 'high' : 'medium',
        });
      }
    });
  });
  return flagged;
}

function recurringChargeFlags(rows) {
  // Only meaningful for genuinely recurring, fixed-price charges (subscriptions,
  // memberships) — applying this to variable spend like rideshares or coffee
  // just flags normal day-to-day price variation as "anomalies".
  const candidates = rows.filter(r => r.amount < 0 && categorize(r.description) === 'subscriptions');

  const byDescription = {};
  candidates.forEach(row => {
    const key = row.description.toLowerCase().trim();
    (byDescription[key] ||= []).push(row);
  });

  const flagged = [];
  Object.values(byDescription).forEach(occurrences => {
    if (occurrences.length < 2) return;
    for (let i = 1; i < occurrences.length; i++) {
      const prev = Math.abs(occurrences[i - 1].amount);
      const curr = Math.abs(occurrences[i].amount);
      if (prev > 0 && Math.abs(curr - prev) / prev > 0.05) {
        flagged.push({
          ...occurrences[i],
          reason: `Recurring charge changed from €${prev.toFixed(2)} to €${curr.toFixed(2)}`,
          severity: 'medium',
        });
      }
    }
  });
  return flagged;
}

// Holds the last parsed statement so the toggle can re-render without
// re-reading the file.
let currentRows = [];
let currentView = 'flagged'; // 'flagged' | 'all'

function runDetection(csvText) {
  const rows = parseCSV(csvText);

  if (rows.length === 0) {
    resultsSection.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector('p').textContent = 'No CSV rows could be read from that file. Check that it has Date, Description, and Amount columns.';
    return;
  }
  emptyState.hidden = true;

  const flags = [...zScoreFlags(rows), ...recurringChargeFlags(rows)];

  // Attach flag info directly onto the matching row so a single row list
  // can serve both the "flagged only" and "all transactions" views.
  rows.forEach(row => {
    const match = flags.find(f => f.date === row.date && f.description === row.description && f.amount === row.amount);
    row.severity = match ? match.severity : null;
    row.reason = match ? match.reason : null;
  });

  currentRows = rows;
  currentView = 'flagged';
  updateToggleButtons();
  render();
}

function render() {
  resultsSection.hidden = false;

  const flaggedRows = currentRows.filter(r => r.severity);
  const rowsToShow = currentView === 'flagged' ? flaggedRows : currentRows;

  resultsTitle.textContent = currentView === 'flagged' ? 'Flagged transactions' : 'All transactions';
  resultsSummary.textContent = `${flaggedRows.length} flagged of ${currentRows.length} transactions`;

  if (rowsToShow.length === 0) {
    ledgerTable.innerHTML = `<p class="row-reason">Nothing stood out — spending looks consistent with your usual patterns.</p>`;
    return;
  }

  ledgerTable.innerHTML = rowsToShow.map(rowHtml).join('');
}

function rowHtml(r) {
  const flagged = Boolean(r.severity);
  const flagLabel = r.severity === 'high' ? 'High' : r.severity === 'medium' ? 'Medium' : '—';
  const flagClass = r.severity ? `flag-${r.severity}` : 'flag-none';

  return `
    <div class="ledger-row${flagged ? '' : ' unflagged'}">
      <div class="row-date">${escapeHtml(r.date)}</div>
      <div class="row-desc-wrap">
        <p class="row-desc">${escapeHtml(r.description)}</p>
        ${r.reason ? `<p class="row-reason">${escapeHtml(r.reason)}</p>` : ''}
      </div>
      <div class="row-amount">€${Math.abs(r.amount).toFixed(2)}</div>
      <div class="row-flag ${flagClass}">${flagLabel}</div>
    </div>
  `;
}

function updateToggleButtons() {
  toggleFlagged.classList.toggle('active', currentView === 'flagged');
  toggleAll.classList.toggle('active', currentView === 'all');
}

toggleFlagged.addEventListener('click', () => { currentView = 'flagged'; updateToggleButtons(); render(); });
toggleAll.addEventListener('click', () => { currentView = 'all'; updateToggleButtons(); render(); });

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
