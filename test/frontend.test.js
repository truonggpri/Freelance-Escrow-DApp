import { expect } from 'chai';
import fs from 'node:fs';
import vm from 'node:vm';
import { ethers } from 'ethers';

// Exercise the actual UI action rendering without a wallet or public RPC.
function ui() {
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', children: [], classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, append(x) { this.children.push(x); }, prepend() {}, replaceChildren() { this.children = []; } });
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  const sandbox = { document, ethers, console, URL, TextEncoder, setTimeout, clearTimeout, setInterval() {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, addEventListener() {} };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('frontend/i18n.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('frontend/app.js', 'utf8'), ctx);
  return { ctx, nodes };
}

describe('Frontend advance actions', function () {
  const client = '0x0000000000000000000000000000000000000001';
  const freelancer = '0x0000000000000000000000000000000000000002';
  const outsider = '0x0000000000000000000000000000000000000003';
  async function render(role, pending, overrides = {}) {
    const { ctx, nodes } = ui();
    ctx.mockJob = { id: 1n, client, freelancer, amount: 100n, title: 'demo', workHash: '', deadline: 1000n, submittedAt: 0n, disputedAt: 0n, status: 0n, revisions: 0n, advancePaid: 0n, cancelRequestedBy: ethers.ZeroAddress, ...overrides };
    ctx.me = { client, freelancer, outsider }[role]; ctx.pending = pending;
    await vm.runInContext(`account = me; signer = {}; provider = { getBlock: async () => ({ timestamp: 100 }) }; contract = {
      jobs: async () => mockJob, arbiter: async () => '${outsider}', REVIEW_PERIOD: async () => 259200n,
      MAX_REVISIONS: async () => 2n, ARBITER_TIMEOUT: async () => 604800n,
      revisionNotes: async () => '', advanceRequested: async () => pending
    }; inspect(1n)`, ctx);
    return nodes.get('actions').children.map(x => x.textContent);
  }
  it('offers request only before a pending or approved advance', async function () {
    expect(await render('freelancer', false)).to.include('Request 50% advance');
    expect(await render('freelancer', true)).not.to.include('Request 50% advance');
    expect(await render('freelancer', false, { advancePaid: 50n })).not.to.include('Request 50% advance');
  });
  it('offers approval/rejection only to the client with a pending request', async function () {
    expect(await render('client', true)).to.include.members(['Approve 50% advance', 'Reject advance']);
    for (const role of ['freelancer', 'outsider']) expect(await render(role, true)).not.to.include('Approve 50% advance');
    expect(await render('client', false)).not.to.include('Approve 50% advance');
    expect(await render('client', true, { deadline: 99n })).not.to.include('Approve 50% advance');
  });
  it('ABI signatures match compiled functions and events used by the main and profile pages', function () {
    const artifact = JSON.parse(fs.readFileSync('artifacts/contracts/FreelanceEscrow.sol/FreelanceEscrow.json'));
    const expected = new ethers.Interface(artifact.abi);
    for (const file of ['frontend/app.js', 'frontend/profile.js']) {
      const source = fs.readFileSync(file, 'utf8');
      const abi = vm.runInNewContext(source.slice(0, source.indexOf('];') + 2) + '\nABI');
      const actual = new ethers.Interface(abi);
      for (const fragment of actual.fragments) {
        const match = fragment.type === 'function' ? expected.getFunction(fragment.format('sighash')) : expected.getEvent(fragment.format('sighash'));
        expect(match.format('full')).to.equal(fragment.format('full'));
      }
    }
  });
});
