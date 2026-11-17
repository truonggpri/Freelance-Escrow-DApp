/* Freelance Escrow client. All authoritative job state lives in the contract. */
const ABI = [
  'function arbiter() view returns (address)',
  'function REVIEW_PERIOD() view returns (uint256)',
  'function MAX_REVISIONS() view returns (uint8)',
  'function ADVANCE_PERCENT() view returns (uint256)',
  'function REVISION_PERIOD() view returns (uint256)',
  'function ARBITER_TIMEOUT() view returns (uint256)',
  'function jobCounter() view returns (uint256)',
  'function jobs(uint256) view returns (uint256 id, address client, address freelancer, string title, uint256 amount, string workHash, uint256 deadline, uint256 submittedAt, uint8 status, uint8 revisions, uint256 disputedAt, address cancelRequestedBy, uint256 advancePaid)',
  'function revisionNotes(uint256) view returns (string)',
  'function balances(address) view returns (uint256)',
  'function getUserJobs(address user) view returns (uint256[])',
  'function createJob(address freelancer, string title, uint256 durationDays) payable returns (uint256)',
  'function advanceRequested(uint256) view returns (bool)',
  'function requestAdvance(uint256 jobId)',
  'function approveAdvance(uint256 jobId)',
  'function rejectAdvance(uint256 jobId)',
  'function submitWork(uint256 jobId, string workHash)',
  'function approveAndPay(uint256 jobId)',
  'function requestRevision(uint256 jobId, string note)',
  'function claimTimeout(uint256 jobId)',
  'function cancelTimeout(uint256 jobId)',
  'function requestCancel(uint256 jobId)',
  'function withdrawCancelRequest(uint256 jobId)',
  'function acceptCancel(uint256 jobId)',
  'function raiseDispute(uint256 jobId)',
  'function resolveDispute(uint256 jobId, uint256 freelancerPercent)',
  'function claimDisputeTimeout(uint256 jobId)',
  'function withdraw()',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed freelancer, uint256 amount, uint256 deadline)',
  'event AdvanceRequested(uint256 indexed jobId, address indexed freelancer)',
  'event AdvanceApproved(uint256 indexed jobId, address indexed client, uint256 amount)',
  'event AdvanceRejected(uint256 indexed jobId, address indexed client)',
  'event AdvanceRequestCleared(uint256 indexed jobId)',
  'event JobStarted(uint256 indexed jobId, address indexed freelancer, uint256 advance)',
  'event WorkSubmitted(uint256 indexed jobId, string workHash, uint256 submittedAt)',
  'event RevisionRequested(uint256 indexed jobId, uint8 revisionNumber, string note, uint256 newDeadline)',
  'event JobCompleted(uint256 indexed jobId, uint256 freelancerAmount, uint256 clientAmount)',
  'event JobCancelled(uint256 indexed jobId)',
  'event CancelRequested(uint256 indexed jobId, address indexed requestedBy)',
  'event CancelRequestWithdrawn(uint256 indexed jobId, address indexed requestedBy)',
  'event DisputeRaised(uint256 indexed jobId, address indexed raisedBy)',
  'event DisputeTimedOut(uint256 indexed jobId, address indexed triggeredBy)',
  'event Withdrawn(address indexed to, uint256 amount)'
];
const SEPOLIA = '0xaa36a7';
const STATUS_STYLE = [
  'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400'
];
const $ = id => document.getElementById(id);
let provider, signer, account, contract, selectedId, refreshTimer;
let myJobs = [];
let isArbiter = false;
let busy = false;
let walletState = 'none'; // none | wrong | ok

function renderWallet() {
  setText('network', t(walletState === 'ok' ? 'c.network.ok' : walletState === 'wrong' ? 'c.network.wrong' : 'c.network.none'));
  setText('connect', account ? shortAddress(account) : t('m.connect'));
}

function log(message) {
  const item = document.createElement('li');
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  $('log').prepend(item);
}
function errorText(error) {
  return trReason(error?.reason || error?.revert?.args?.[0] || error?.info?.error?.message || error?.shortMessage || error?.message || String(error));
}
function fail(error) { console.error(error); log(t('log.error', { msg: errorText(error) })); }
function shortAddress(address) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
function sameAddress(a, b) { return a && b && a.toLowerCase() === b.toLowerCase(); }
function isZeroAddress(a) { return !a || a === ethers.ZeroAddress; }
function positiveId(value) {
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) throw new Error(t('err.badId'));
  return BigInt(value);
}
function setText(id, value) { $(id).textContent = value; }
function withTimeout(promise, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(t('err.timeout'))), ms);
  })]).finally(() => clearTimeout(timer));
}
function resetDetails() {
  selectedId = undefined;
  $('jobDetails').classList.add('hidden'); $('emptyState').classList.remove('hidden');
  renderMyJobs();
}
function clearAccountData() {
  myJobs = []; isArbiter = false;
  setText('pendingAmount', '—'); $('withdraw').disabled = true;
  renderMyJobs();
}

async function switchNetwork() {
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA }] }); }
  catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: SEPOLIA, chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] }] });
  }
}
async function connect() {
  if (!window.ethereum) throw new Error(t('err.noWallet'));
  if (!window.ethers) throw new Error(t('err.noEthers'));
  await window.ethereum.request({ method: 'eth_requestAccounts' });
  const chain = await window.ethereum.request({ method: 'eth_chainId' });
  if (chain.toLowerCase() !== SEPOLIA) await switchNetwork();
  await updateWallet();
}
async function updateWallet() {
  contract = undefined; signer = undefined; account = undefined;
  if (!window.ethereum || !window.ethers) return;
  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  const chain = await window.ethereum.request({ method: 'eth_chainId' });
  if (!accounts.length) {
    walletState = 'none'; renderWallet(); clearAccountData(); resetDetails(); return;
  }
  account = accounts[0];
  if (chain.toLowerCase() !== SEPOLIA) {
    walletState = 'wrong'; renderWallet(); clearAccountData(); resetDetails(); return;
  }
  walletState = 'ok'; renderWallet();
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  await loadContract(false);
  if (contract) await refreshAll(); else clearAccountData();
}
async function loadContract(requireAddress = true) {
  contract = undefined;
  const address = $('contractAddress').value.trim();
  if (!address) { if (requireAddress) throw new Error(t('err.enterAddr')); return; }
  if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(t('err.invalidAddr'));
  if (!signer) { if (requireAddress) throw new Error(t('err.connectFirst')); return; }
  if (await withTimeout(provider.getCode(address)) === '0x') throw new Error(t('err.noContract'));
  const candidate = new ethers.Contract(address, ABI, signer);
  await withTimeout(candidate.arbiter()); // Verify the expected interface before enabling actions.
  try { await withTimeout(candidate.advanceRequested(0)); }
  catch (_) { throw new Error(t('err.oldContract')); }
  if ($('contractAddress').value.trim() !== address) throw new Error(t('err.addrChanged'));
  contract = candidate;
}
async function requireContract() {
  if (!account || !signer) throw new Error(t('err.connectFirst'));
  if (!contract) await loadContract();
  return contract;
}
async function transact(description, send) {
  if (busy) return false;
  busy = true;
  let ok = false;
  try {
    const instance = await requireContract();
    log(t('log.confirm', { action: description }));
    const tx = await send(instance);
    log(t('log.pending', { hash: tx.hash }));
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(t('err.txFailed'));
    log(t('log.confirmed', { n: receipt.blockNumber }));
    for (const entry of receipt.logs) {
      try {
        const parsed = instance.interface.parseLog(entry);
        if (parsed?.name === 'JobCreated') { log(t('log.created', { id: parsed.args.jobId })); $('inspectId').value = parsed.args.jobId.toString(); selectedId = parsed.args.jobId; }
        if (parsed?.name === 'Withdrawn') log(t('log.withdrew', { amount: ethers.formatEther(parsed.args.amount) }));
        if (parsed?.name === 'AdvanceRequested') log(t('log.advanceRequested'));
        if (parsed?.name === 'AdvanceRejected') log(t('log.advanceRejected'));
        if (parsed?.name === 'JobStarted') log(t('log.started', { amount: ethers.formatEther(parsed.args.advance) }));
      } catch (_) { /* Ignore unrelated logs. */ }
    }
    ok = true;
    if (contract === instance) await refreshAll();
  } catch (error) { fail(error); }
  finally { busy = false; }
  return ok;
}

/* ---------- pending balance (pull payments) ---------- */
async function loadPending() {
  if (!contract || !account) { setText('pendingAmount', '—'); $('withdraw').disabled = true; return; }
  const c = contract;
  const balance = await c.balances(account);
  if (contract !== c) return;
  setText('pendingAmount', `${ethers.formatEther(balance)} ETH`);
  $('withdraw').disabled = balance === 0n;
}

/* ---------- "My jobs" list ---------- */
function toJob(raw) {
  return {
    id: raw.id, client: raw.client, freelancer: raw.freelancer, title: raw.title, amount: raw.amount,
    status: Number(raw.status), revisions: Number(raw.revisions), cancelRequestedBy: raw.cancelRequestedBy, advancePaid: raw.advancePaid
  };
}
async function fetchJobs(c, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    out.push(...await Promise.all(ids.slice(i, i + 20).map(async id => {
      const [raw, pending] = await Promise.all([c.jobs(id), c.advanceRequested(id)]);
      return { ...toJob(raw), advanceRequested: pending };
    })));
  }
  return out;
}
async function loadMyJobs() {
  if (!contract || !account) { myJobs = []; renderMyJobs(); return; }
  const c = contract, me = account;
  const [mineIds, arbiter] = await Promise.all([c.getUserJobs(me), c.arbiter()]);
  const arbiterMode = sameAddress(me, arbiter);
  let jobs;
  if (arbiterMode) {
    // The arbiter is usually not a party, so also surface every disputed job awaiting a decision.
    const count = Number(await c.jobCounter());
    jobs = await fetchJobs(c, Array.from({ length: count }, (_, i) => BigInt(i + 1)));
    jobs = jobs.filter(j => sameAddress(j.client, me) || sameAddress(j.freelancer, me) || j.status === 3);
  } else {
    jobs = await fetchJobs(c, Array.from(mineIds));
  }
  if (contract !== c || account !== me) return; // wallet or contract changed meanwhile
  isArbiter = arbiterMode;
  myJobs = jobs.map(j => ({
    ...j,
    roles: [sameAddress(j.client, me) && 'client', sameAddress(j.freelancer, me) && 'freelancer', arbiterMode && j.status === 3 && 'arbiter'].filter(Boolean)
  }));
  renderMyJobs();
}
function nextAction(j) {
  const me = account;
  const party = sameAddress(j.client, me) || sameAddress(j.freelancer, me);
  // A pending cancel request from the other side is the first thing to answer.
  if (j.status === 0 && party && !isZeroAddress(j.cancelRequestedBy) && !sameAddress(j.cancelRequestedBy, me)) return t('pill.cancelRequest');
  if (j.status === 0 && party && j.advanceRequested) return t(sameAddress(j.client, me) ? 'pill.advanceReview' : 'pill.advancePending');
  if (j.status === 1 && sameAddress(j.client, me)) return t('pill.review');
  if (j.status === 0 && sameAddress(j.freelancer, me)) {
    if (j.revisions > 0) return t('pill.revision');
    return j.advancePaid === 0n ? t('pill.start') : t('pill.submit');
  }
  if (j.status === 3 && j.roles?.includes('arbiter')) return t('pill.resolve');
  return '';
}
function pill(text, cls) {
  const el = document.createElement('span');
  el.className = `rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`;
  el.textContent = text;
  return el;
}
function renderMyJobs() {
  const list = $('myJobs'); list.replaceChildren();
  const role = $('roleFilter').value, status = $('statusFilter').value;
  const rows = myJobs
    .filter(j => (role === 'all' || j.roles.includes(role)) && (status === 'all' || String(j.status) === status))
    .sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  setText('myJobsCount', myJobs.length ? t('m.my.count', { a: rows.length, b: myJobs.length }) : '');
  const empty = $('myJobsEmpty');
  if (!rows.length) {
    empty.classList.remove('hidden');
    empty.textContent = !account ? t('m.my.empty.connect')
      : !contract ? t('m.my.empty.noContract')
      : myJobs.length ? t('m.my.empty.noMatch')
      : t('m.my.empty.none');
    return;
  }
  empty.classList.add('hidden');
  for (const j of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `job-item${selectedId === j.id ? ' selected' : ''}`;
    button.addEventListener('click', () => {
      inspect(j.id).then(() => $('jobDetails').scrollIntoView({ behavior: 'smooth', block: 'nearest' })).catch(fail);
    });

    const top = document.createElement('div');
    top.className = 'flex items-start justify-between gap-3';
    const title = document.createElement('div');
    title.className = 'min-w-0';
    const num = document.createElement('div');
    num.className = 'text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400';
    num.textContent = `Job #${j.id}`;
    const name = document.createElement('div');
    name.className = 'truncate text-sm font-semibold text-slate-900 dark:text-white';
    name.textContent = j.title; name.title = j.title;
    title.append(num, name);
    const amount = document.createElement('div');
    amount.className = 'shrink-0 font-mono text-xs font-bold text-emerald-600 dark:text-emerald-400';
    amount.textContent = `${ethers.formatEther(j.amount)} ETH`;
    top.append(title, amount);

    const meta = document.createElement('div');
    meta.className = 'mt-2 flex flex-wrap items-center gap-1.5';
    meta.append(pill(t('s.' + j.status), STATUS_STYLE[j.status] || STATUS_STYLE[4]));
    for (const r of j.roles) meta.append(pill(t('role.pill.' + r), 'border-slate-400/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'));
    const action = nextAction(j);
    if (action) meta.append(pill(`● ${action}`, 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'));

    button.append(top, meta);
    list.append(button);
  }
}

/* ---------- job details ---------- */
function timeRemaining(target, now) {
  const seconds = Number(target - now);
  if (seconds < 0) return t('time.expired');
  if (seconds === 0) return t('time.now');
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  return t('time.dhm', { d, h, m });
}
function addAction(labelKey, method, id, style = 'btn-outline') {
  const label = t(labelKey);
  const button = document.createElement('button');
  button.type = 'button'; button.className = `btn ${style}`; button.textContent = label;
  button.addEventListener('click', () => transact(label, c => c[method](id)));
  $('actions').append(button);
}
function showProof(proof) {
  const container = $('jobProof'); container.replaceChildren();
  if (!proof) { container.textContent = t('m.det.notSubmitted'); return; }
  let url;
  try { const parsed = new URL(proof); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href; } catch (_) { /* SHA and CID are displayed as text. */ }
  if (url) {
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'proof-link'; link.textContent = proof; container.append(link);
  } else container.textContent = proof;
}
async function inspect(rawId) {
  const id = positiveId(String(rawId));
  const c = await requireContract();
  const [job, arbiter, reviewPeriod, maxRevisions, arbiterTimeout, block, note, pendingAdvance] = await Promise.all([
    c.jobs(id), c.arbiter(), c.REVIEW_PERIOD(), c.MAX_REVISIONS(), c.ARBITER_TIMEOUT(), provider.getBlock('latest'), c.revisionNotes(id), c.advanceRequested(id)
  ]);
  if (job.id === 0n) throw new Error(t('err.jobMissing'));
  if (!block) throw new Error(t('err.noBlock'));
  selectedId = id; $('inspectId').value = id.toString();
  const status = Number(job.status), now = BigInt(block.timestamp);
  const client = sameAddress(account, job.client), freelancer = sameAddress(account, job.freelancer), party = client || freelancer;
  const revisionsUsed = Number(job.revisions), revisionsLeft = Number(maxRevisions) - revisionsUsed;
  const reviewEnd = job.submittedAt + reviewPeriod;

  setText('jobNumber', `JOB #${job.id}`); setText('jobTitle', job.title); setText('jobStatus', t('s.' + status));
  setText('jobAmount', `${ethers.formatEther(job.amount)} ETH`); setText('jobClient', job.client); setText('jobFreelancer', job.freelancer);
  const target = status === 0 ? job.deadline : status === 1 ? reviewEnd : status === 3 ? job.disputedAt + arbiterTimeout : null;
  const targetLabel = t(status === 0 ? 'time.toDeadline' : status === 1 ? 'time.inReview' : 'time.toArbiter');
  setText('jobTime', target === null ? '—' : `${timeRemaining(target, now)} ${targetLabel}`);
  showProof(job.workHash);
  setText('jobRevisions', t('m.det.used', { used: revisionsUsed, max: maxRevisions }));
  const advance = job.advancePaid;
  $('jobAdvanceBox').classList.toggle('hidden', advance === 0n);
  if (advance > 0n) setText('jobAdvance', t('m.det.advanceVal', { adv: ethers.formatEther(advance), left: ethers.formatEther(job.amount - advance) }));
  $('jobNoteBox').classList.toggle('hidden', !(revisionsUsed > 0 && note));
  setText('jobNote', note);
  const requester = job.cancelRequestedBy;
  $('jobCancelBox').classList.toggle('hidden', isZeroAddress(requester));
  if (!isZeroAddress(requester)) {
    const key = sameAddress(requester, job.client) ? 'm.det.cancelClient' : 'm.det.cancelFreelancer';
    setText('jobCancel', t(key, { you: sameAddress(requester, account) ? t('c.you') : '' }));
  }
  if (freelancer) { const field = document.querySelector('#submitForm [name="jobId"]'); if (field) field.value = id.toString(); }

  $('actions').replaceChildren(); $('resolveForm').classList.add('hidden'); $('revisionForm').classList.add('hidden');
  if (status === 0 && advance === 0n && !job.workHash && now <= job.deadline && isZeroAddress(requester)) {
    if (freelancer && !pendingAdvance && job.amount >= 2n) addAction('act.start', 'requestAdvance', id, 'btn-primary');
    if (client && pendingAdvance) addAction('act.approveAdvance', 'approveAdvance', id, 'btn-primary');
  }
  if (status === 0 && client && pendingAdvance) addAction('act.rejectAdvance', 'rejectAdvance', id);
  if (status === 1 && client) addAction('act.approve', 'approveAndPay', id, 'btn-primary');
  if (status === 1 && client && revisionsLeft > 0 && now <= reviewEnd) {
    $('revisionForm').classList.remove('hidden');
    setText('revisionLeft', t('m.rev.left', { n: revisionsLeft }));
  }
  if (status === 1 && freelancer && now > reviewEnd) addAction('act.claim', 'claimTimeout', id, 'btn-primary');
  if (status === 0 && client && now > job.deadline) addAction('act.cancelRefund', 'cancelTimeout', id);
  if (status === 0 && party) {
    if (isZeroAddress(requester)) addAction('act.requestCancel', 'requestCancel', id);
    else if (sameAddress(requester, account)) addAction('act.withdrawCancel', 'withdrawCancelRequest', id);
    else addAction(client ? 'act.acceptCancelClient' : 'act.acceptCancelFreelancer', 'acceptCancel', id, 'btn-primary');
  }
  if ((status === 0 || status === 1) && party) addAction('act.dispute', 'raiseDispute', id);
  if (status === 3 && party && now > job.disputedAt + arbiterTimeout) addAction('act.force', 'claimDisputeTimeout', id, 'btn-primary');
  if (status === 3 && sameAddress(account, arbiter)) $('resolveForm').classList.remove('hidden');

  const days = n => Number(n) / 86400;
  let hint;
  if (status === 3) hint = t('hint.disputed', { arb: shortAddress(arbiter), days: days(arbiterTimeout) });
  else if (status === 1) hint = t('hint.submitted', { left: revisionsLeft, days: days(reviewPeriod) });
  else if (status === 0 && revisionsUsed > 0) hint = t('hint.revision');
  else if (status === 0 && advance > 0n) hint = t('hint.createdStarted', { adv: ethers.formatEther(advance) });
  else if (status === 0 && pendingAdvance) hint = t(now > job.deadline ? 'hint.advanceExpired' : 'hint.advancePending');
  else if (status === 0) hint = t('hint.created');
  else hint = t('hint.settled');
  setText('actionHint', hint);
  $('emptyState').classList.add('hidden'); $('jobDetails').classList.remove('hidden');
  renderMyJobs();
}

async function refreshAll() {
  await Promise.all([loadMyJobs(), loadPending()]);
  if (selectedId && contract) await inspect(selectedId);
}

/* ---------- events ---------- */
$('connect').addEventListener('click', () => connect().catch(fail));
$('saveContract').addEventListener('click', async () => {
  $('saveContract').disabled = true;
  setText('contractMessage', t('log.checkingSepolia'));
  log(t('log.checking'));
  try {
    const value = $('contractAddress').value.trim();
    if (!window.ethers) throw new Error(t('err.noEthers'));
    if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(t('err.invalidAddr'));
    contract = undefined; clearAccountData(); resetDetails();
    if (signer) { await loadContract(); await refreshAll(); }
    try { localStorage.setItem('freelanceEscrowContract', value); } catch (_) { /* storage unavailable */ }
    const message = signer ? t('log.loaded', { addr: value }) : t('log.saved');
    setText('contractMessage', message);
    log(message);
  } catch (error) { setText('contractMessage', t('log.error', { msg: errorText(error) })); fail(error); }
  finally { $('saveContract').disabled = false; }
});
$('contractAddress').addEventListener('input', () => { contract = undefined; setText('contractMessage', ''); clearAccountData(); resetDetails(); });
$('createForm').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  transact(t('act.createJob'), c => {
    const freelancer = String(data.get('freelancer')).trim(), title = String(data.get('title')).trim();
    if (!ethers.isAddress(freelancer) || freelancer === ethers.ZeroAddress || sameAddress(freelancer, account)) throw new Error(t('err.badFreelancer'));
    if (!title) throw new Error(t('err.noTitle'));
    const amount = ethers.parseEther(String(data.get('amount')).trim());
    if (amount <= 0n) throw new Error(t('err.depositPos'));
    return c.createJob(freelancer, title, positiveId(String(data.get('duration'))), { value: amount });
  });
});
$('submitForm').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  transact(t('act.submit'), c => { const proof = String(data.get('proof')).trim(); if (!proof) throw new Error(t('err.noProof')); return c.submitWork(positiveId(String(data.get('jobId'))), proof); });
});
$('inspectForm').addEventListener('submit', event => { event.preventDefault(); inspect($('inspectId').value).catch(fail); });
$('resolveForm').addEventListener('submit', event => {
  event.preventDefault(); const value = String(new FormData(event.currentTarget).get('percent'));
  transact(t('act.resolve'), c => { if (!/^\d+$/.test(value) || Number(value) > 100) throw new Error(t('err.badPercent')); return c.resolveDispute(selectedId, value); });
});
$('revisionForm').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = String(new FormData(form).get('note')).trim();
  transact(t('act.revision'), c => {
    if (!note) throw new Error(t('err.noNote'));
    if (new TextEncoder().encode(note).length > 500) throw new Error(t('err.noteLong'));
    return c.requestRevision(selectedId, note);
  }).then(ok => { if (ok) form.reset(); });
});
$('withdraw').addEventListener('click', () => transact(t('act.withdraw'), c => c.withdraw()));
$('roleFilter').addEventListener('change', renderMyJobs);
$('statusFilter').addEventListener('change', renderMyJobs);
$('refreshJobs').addEventListener('click', () => { if (!busy) refreshAll().catch(fail); });

try { $('contractAddress').value = localStorage.getItem('freelanceEscrowContract') || ''; } catch (_) { log(t('log.noStorage')); }
renderMyJobs();
renderWallet();
// Re-render everything that is built from script when the user flips the language button.
window.addEventListener('escrow:lang', () => {
  renderWallet(); renderMyJobs();
  if (selectedId && contract && !busy) inspect(selectedId).catch(fail);
});
if (window.ethereum) {
  window.ethereum.on('accountsChanged', () => updateWallet().catch(fail));
  window.ethereum.on('chainChanged', () => updateWallet().catch(fail));
  updateWallet().catch(fail);
}
// Refresh against the latest block, since block timestamps govern timeout actions.
refreshTimer = setInterval(() => { if (contract && !busy) refreshAll().catch(fail); }, 30000);
