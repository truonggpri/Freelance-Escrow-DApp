/* Freelance Escrow client. All authoritative job state lives in the contract. */
const ABI = [
  'function arbiter() view returns (address)',
  'function REVIEW_PERIOD() view returns (uint256)',
  'function jobCounter() view returns (uint256)',
  'function jobs(uint256) view returns (uint256 id, address client, address freelancer, string title, uint256 amount, string workHash, uint256 deadline, uint256 submittedAt, uint8 status)',
  'function createJob(address freelancer, string title, uint256 durationDays) payable returns (uint256)',
  'function submitWork(uint256 jobId, string workHash)',
  'function approveAndPay(uint256 jobId)',
  'function claimTimeout(uint256 jobId)',
  'function cancelTimeout(uint256 jobId)',
  'function raiseDispute(uint256 jobId)',
  'function resolveDispute(uint256 jobId, uint256 freelancerPercent)',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed freelancer, uint256 amount, uint256 deadline)',
  'event WorkSubmitted(uint256 indexed jobId, string workHash, uint256 submittedAt)',
  'event JobCompleted(uint256 indexed jobId, uint256 freelancerAmount, uint256 clientAmount)',
  'event JobCancelled(uint256 indexed jobId)',
  'event DisputeRaised(uint256 indexed jobId, address indexed raisedBy)'
];
const SEPOLIA = '0xaa36a7';
const STATUS = ['Created', 'Submitted', 'Completed', 'Disputed', 'Cancelled'];
const $ = id => document.getElementById(id);
let provider, signer, account, contract, selectedId, refreshTimer;
let busy = false;

function log(message) {
  const item = document.createElement('li');
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  $('log').prepend(item);
}
function errorText(error) {
  return error?.reason || error?.revert?.args?.[0] || error?.info?.error?.message || error?.shortMessage || error?.message || String(error);
}
function fail(error) { console.error(error); log(`Error: ${errorText(error)}`); }
function shortAddress(address) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
function sameAddress(a, b) { return a && b && a.toLowerCase() === b.toLowerCase(); }
function positiveId(value) {
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) throw new Error('Enter a valid positive job ID.');
  return BigInt(value);
}
function setText(id, value) { $(id).textContent = value; }
function withTimeout(promise, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Connection to Sepolia timed out. Check your wallet network or RPC and try again.')), ms);
  })]).finally(() => clearTimeout(timer));
}
function resetDetails() { selectedId = undefined; $('jobDetails').classList.add('hidden'); $('emptyState').classList.remove('hidden'); }

async function switchNetwork() {
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA }] }); }
  catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: SEPOLIA, chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] }] });
  }
}
async function connect() {
  if (!window.ethereum) throw new Error('MetaMask or another EIP-1193 wallet is required.');
  if (!window.ethers) throw new Error('Ethers.js could not load. Check your internet connection.');
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
    setText('connect', 'Connect wallet ↗'); setText('network', 'Wallet not connected'); resetDetails(); return;
  }
  account = accounts[0];
  setText('connect', shortAddress(account));
  if (chain.toLowerCase() !== SEPOLIA) {
    setText('network', 'Wrong network · switch to Sepolia'); resetDetails(); return;
  }
  setText('network', 'Sepolia connected');
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  await loadContract(false);
  if (selectedId && contract) await inspect(selectedId);
}
async function loadContract(requireAddress = true) {
  contract = undefined;
  const address = $('contractAddress').value.trim();
  if (!address) { if (requireAddress) throw new Error('Enter a contract address.'); return; }
  if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error('Enter a valid contract address.');
  if (!signer) { if (requireAddress) throw new Error('Connect your wallet on Sepolia first.'); return; }
  if (await withTimeout(provider.getCode(address)) === '0x') throw new Error('No contract found at this address on Sepolia.');
  const candidate = new ethers.Contract(address, ABI, signer);
  await withTimeout(candidate.arbiter()); // Verify the expected interface before enabling actions.
  if ($('contractAddress').value.trim() !== address) throw new Error('Address changed during verification. Save it again.');
  contract = candidate;
}
async function requireContract() {
  if (!account || !signer) throw new Error('Connect your wallet on Sepolia first.');
  if (!contract) await loadContract();
  return contract;
}
async function transact(description, send) {
  if (busy) return;
  busy = true;
  try {
    const instance = await requireContract();
    log(`${description}: confirm in your wallet…`);
    const tx = await send(instance);
    log(`Pending: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('Transaction failed.');
    log(`Confirmed in block ${receipt.blockNumber}.`);
    for (const entry of receipt.logs) {
      try {
        const parsed = instance.interface.parseLog(entry);
        if (parsed?.name === 'JobCreated') { log(`Job created: #${parsed.args.jobId}`); $('inspectId').value = parsed.args.jobId.toString(); selectedId = parsed.args.jobId; }
      } catch (_) { /* Ignore unrelated logs. */ }
    }
    if (selectedId && contract === instance) await inspect(selectedId);
  } catch (error) { fail(error); }
  finally { busy = false; }
}
function timeRemaining(target, now) {
  const seconds = Number(target - now);
  if (seconds < 0) return 'Expired';
  if (seconds === 0) return 'Expires now';
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  return `${d}d ${h}h ${m}m`;
}
function addAction(label, method, id) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn btn-outline'; button.textContent = label;
  button.addEventListener('click', () => transact(label, c => c[method](id)));
  $('actions').append(button);
}
function showProof(proof) {
  const container = $('jobProof'); container.replaceChildren();
  if (!proof) { container.textContent = 'Not submitted'; return; }
  let url;
  try { const parsed = new URL(proof); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href; } catch (_) { /* SHA and CID are displayed as text. */ }
  if (url) {
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'proof-link'; link.textContent = proof; container.append(link);
  } else container.textContent = proof;
}
async function inspect(rawId) {
  const id = positiveId(String(rawId));
  const c = await requireContract();
  const [job, arbiter, reviewPeriod, block] = await Promise.all([c.jobs(id), c.arbiter(), c.REVIEW_PERIOD(), provider.getBlock('latest')]);
  if (job.id === 0n) throw new Error('Job does not exist.');
  if (!block) throw new Error('Could not read the latest block.');
  selectedId = id; $('inspectId').value = id.toString();
  const status = Number(job.status), now = BigInt(block.timestamp);
  setText('jobNumber', `JOB #${job.id}`); setText('jobTitle', job.title); setText('jobStatus', STATUS[status] || 'Unknown');
  setText('jobAmount', `${ethers.formatEther(job.amount)} ETH`); setText('jobClient', job.client); setText('jobFreelancer', job.freelancer);
  const target = status === 0 ? job.deadline : status === 1 ? job.submittedAt + reviewPeriod : null;
  setText('jobTime', target === null ? '—' : `${timeRemaining(target, now)} ${status === 0 ? 'to deadline' : 'in review'}`);
  showProof(job.workHash);
  $('actions').replaceChildren(); $('resolveForm').classList.add('hidden');
  const client = sameAddress(account, job.client), freelancer = sameAddress(account, job.freelancer);
  if (status === 1 && client) addAction('Approve & pay', 'approveAndPay', id);
  if (status === 1 && freelancer && now > job.submittedAt + reviewPeriod) addAction('Claim payout', 'claimTimeout', id);
  if (status === 0 && client && now > job.deadline) addAction('Cancel & refund', 'cancelTimeout', id);
  if ((status === 0 || status === 1) && (client || freelancer)) addAction('Raise dispute', 'raiseDispute', id);
  if (status === 3 && sameAddress(account, arbiter)) $('resolveForm').classList.remove('hidden');
  setText('actionHint', status === 3 ? `Awaiting arbitration by ${shortAddress(arbiter)}.` : status === 1 ? 'The freelancer can claim after the three-day review period.' : status === 0 ? 'The client can request a refund after the deadline if work was not submitted.' : 'This agreement has been settled.');
  $('emptyState').classList.add('hidden'); $('jobDetails').classList.remove('hidden');
}

$('connect').addEventListener('click', () => connect().catch(fail));
$('saveContract').addEventListener('click', async () => {
  $('saveContract').disabled = true;
  setText('contractMessage', 'Checking contract address on Sepolia…');
  log('Checking contract address…');
  try {
    const value = $('contractAddress').value.trim();
    if (!window.ethers) throw new Error('Ethers.js could not load. Check your internet connection.');
    if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error('Enter a valid contract address.');
    contract = undefined; resetDetails();
    if (signer) await loadContract();
    localStorage.setItem('freelanceEscrowContract', value);
    const message = signer ? `Contract loaded: ${value}` : 'Address saved. Connect to Sepolia to verify it.';
    setText('contractMessage', message);
    log(message);
  } catch (error) { setText('contractMessage', `Error: ${errorText(error)}`); fail(error); }
  finally { $('saveContract').disabled = false; }
});
$('contractAddress').addEventListener('input', () => { contract = undefined; setText('contractMessage', ''); resetDetails(); });
$('createForm').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  transact('Create job', c => {
    const freelancer = String(data.get('freelancer')).trim(), title = String(data.get('title')).trim();
    if (!ethers.isAddress(freelancer) || freelancer === ethers.ZeroAddress || sameAddress(freelancer, account)) throw new Error('Enter a valid freelancer address different from your own.');
    if (!title) throw new Error('Enter a job title.');
    const amount = ethers.parseEther(String(data.get('amount')).trim());
    if (amount <= 0n) throw new Error('Deposit must be greater than zero.');
    return c.createJob(freelancer, title, positiveId(String(data.get('duration'))), { value: amount });
  });
});
$('submitForm').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  transact('Submit work', c => { const proof = String(data.get('proof')).trim(); if (!proof) throw new Error('Enter proof of work.'); return c.submitWork(positiveId(String(data.get('jobId'))), proof); });
});
$('inspectForm').addEventListener('submit', event => { event.preventDefault(); inspect($('inspectId').value).catch(fail); });
$('resolveForm').addEventListener('submit', event => {
  event.preventDefault(); const value = String(new FormData(event.currentTarget).get('percent'));
  transact('Resolve dispute', c => { if (!/^\d+$/.test(value) || Number(value) > 100) throw new Error('Enter a percentage from 0 to 100.'); return c.resolveDispute(selectedId, value); });
});
try { $('contractAddress').value = localStorage.getItem('freelanceEscrowContract') || ''; } catch (_) { log('Local storage is unavailable; the contract address will not be saved.'); }
if (window.ethereum) {
  window.ethereum.on('accountsChanged', () => updateWallet().catch(fail));
  window.ethereum.on('chainChanged', () => updateWallet().catch(fail));
  updateWallet().catch(fail);
}
// Refresh against the latest block, since block timestamps govern timeout actions.
refreshTimer = setInterval(() => { if (selectedId && contract && !busy) inspect(selectedId).catch(fail); }, 30000);
