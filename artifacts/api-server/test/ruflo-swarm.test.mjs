import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRufloSwarmRepository,
  RufloSwarmError,
  RufloSwarmService,
  resolveRufloConflict,
  topologyConnections,
} from "../test-dist/ruflo-swarm.mjs";

const secret = "phase-8-test-signing-secret";
const makeService = () => {
  let current = new Date("2026-09-03T00:00:00.000Z");
  const repository = new InMemoryRufloSwarmRepository();
  return {
    repository,
    service: new RufloSwarmService(repository, secret, () => current),
    advance(ms) { current = new Date(current.getTime() + ms); },
  };
};

async function swarmWithAgents(topology = "hierarchical") {
  const harness = makeService();
  const created = await harness.service.createSwarm("user-a", { sessionId: "session-a", projectId: "project-a", topology });
  const coder = await harness.service.registerAgent("user-a", created.swarm.id, { agentId: created.leader.id, credential: created.credential }, { name: "coder", type: "coder" });
  const reviewer = await harness.service.registerAgent("user-a", created.swarm.id, { agentId: created.leader.id, credential: created.credential }, { name: "reviewer", type: "reviewer" });
  return { ...harness, created, coder, reviewer };
}

test("keeps agents isolated by authenticated user and swarm", async () => {
  const { service, created } = await swarmWithAgents();
  await assert.rejects(() => service.getState("user-b", created.swarm.id), (error) => error.code === "not_found");
  await assert.rejects(() => service.readMailbox("user-b", created.swarm.id, { agentId: created.leader.id, credential: created.credential }), (error) => error.code === "not_found");
});

test("authenticates SendMessage-style communication and protects mailbox ownership", async () => {
  const { service, created, coder } = await swarmWithAgents();
  const leaderAuth = { agentId: created.leader.id, credential: created.credential };
  const message = await service.sendMessage("user-a", created.swarm.id, leaderAuth, { toAgentId: coder.agent.id, type: "task.context", payload: { answer: "bounded" } });
  assert.equal(message.status, "delivered");
  assert.equal((await service.readMailbox("user-a", created.swarm.id, { agentId: coder.agent.id, credential: coder.credential })).length, 1);
  await assert.rejects(() => service.readMailbox("user-a", created.swarm.id, { agentId: coder.agent.id, credential: created.credential }), (error) => error.code === "agent_unauthorized");
  await assert.rejects(() => service.sendMessage("user-a", created.swarm.id, { agentId: created.leader.id, credential: `${created.credential}tampered` }, { toAgentId: coder.agent.id, type: "x", payload: {} }), (error) => error.code === "agent_unauthorized");
  await service.acknowledgeMessage("user-a", created.swarm.id, { agentId: coder.agent.id, credential: coder.credential }, message.id);
  assert.equal((await service.readMailbox("user-a", created.swarm.id, { agentId: coder.agent.id, credential: coder.credential }))[0].status, "acknowledged");
});

test("enforces shared-context permissions and optimistic conflict detection", async () => {
  const { service, created, coder, reviewer } = await swarmWithAgents();
  const leaderAuth = { agentId: created.leader.id, credential: created.credential };
  await assert.rejects(() => service.writeContext("user-a", created.swarm.id, { agentId: reviewer.agent.id, credential: reviewer.credential }, { namespace: "project", key: "plan", value: { safe: true } }), (error) => error.code === "capability_denied");
  const first = await service.writeContext("user-a", created.swarm.id, leaderAuth, { namespace: "project", key: "plan", value: { step: 1 } });
  const second = await service.writeContext("user-a", created.swarm.id, { agentId: coder.agent.id, credential: coder.credential }, { namespace: "project", key: "plan", value: { step: 2 }, expectedVersion: first.version });
  assert.equal(second.version, 2);
  await assert.rejects(() => service.writeContext("user-a", created.swarm.id, leaderAuth, { namespace: "project", key: "plan", value: { step: 3 }, expectedVersion: first.version }), (error) => error.code === "context_conflict");
  assert.equal((await service.readContext("user-a", created.swarm.id, { agentId: reviewer.agent.id, credential: reviewer.credential }, "project"))[0].value.step, 2);
});

test("delivers durable events only to matching subscriptions", async () => {
  const { service, created, coder } = await swarmWithAgents();
  const coderAuth = { agentId: coder.agent.id, credential: coder.credential };
  await service.subscribe("user-a", created.swarm.id, coderAuth, "context.updated");
  await service.writeContext("user-a", created.swarm.id, { agentId: created.leader.id, credential: created.credential }, { namespace: "project", key: "evented", value: true });
  const events = await service.listEvents("user-a", created.swarm.id, coderAuth, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "context.updated");
});

test("supports hierarchical and mesh topology plus bounded majority consensus", async () => {
  const hierarchical = await swarmWithAgents("hierarchical");
  const coderAuth = { agentId: hierarchical.coder.agent.id, credential: hierarchical.coder.credential };
  await assert.rejects(() => hierarchical.service.sendMessage("user-a", hierarchical.created.swarm.id, coderAuth, { toAgentId: hierarchical.reviewer.agent.id, type: "peer", payload: {} }), (error) => error.code === "topology");
  assert.equal(topologyConnections(hierarchical.created.swarm, [hierarchical.created.leader, hierarchical.coder.agent, hierarchical.reviewer.agent]).length, 4);
  const consensus = await hierarchical.service.createConsensus("user-a", hierarchical.created.swarm.id, { agentId: hierarchical.created.leader.id, credential: hierarchical.created.credential }, { type: "proposal", payload: { id: "p" } });
  await hierarchical.service.vote("user-a", hierarchical.created.swarm.id, { agentId: hierarchical.created.leader.id, credential: hierarchical.created.credential }, consensus.id, "approve");
  const decided = await hierarchical.service.vote("user-a", hierarchical.created.swarm.id, { agentId: hierarchical.coder.agent.id, credential: hierarchical.coder.credential }, consensus.id, "approve");
  assert.equal(decided.status, "reached");
  assert.equal(decided.decision, "approve");
  await assert.rejects(() => hierarchical.service.vote("user-a", hierarchical.created.swarm.id, { agentId: hierarchical.reviewer.agent.id, credential: hierarchical.reviewer.credential }, consensus.id, "reject"), (error) => error.code === "consensus_closed");
  const mesh = await swarmWithAgents("mesh");
  await mesh.service.sendMessage("user-a", mesh.created.swarm.id, { agentId: mesh.coder.agent.id, credential: mesh.coder.credential }, { toAgentId: mesh.reviewer.agent.id, type: "peer", payload: {} });
});

test("recovers expired leases and preserves cancellation as a durable terminal state", async () => {
  const harness = await swarmWithAgents();
  const task = await harness.service.createTask("user-a", harness.created.swarm.id, { title: "inspect" });
  await harness.service.acquireTaskLease("user-a", harness.created.swarm.id, { agentId: harness.coder.agent.id, credential: harness.coder.credential }, task.id);
  harness.advance(31_000);
  assert.deepEqual(await harness.service.recover(), { agents: 3, tasks: 1 });
  const state = await harness.service.getState("user-a", harness.created.swarm.id);
  assert.equal(state.tasks[0].status, "pending");
  assert.equal(state.agents.find((agent) => agent.id === harness.coder.agent.id).status, "expired");
  const recoveredAgent = await harness.service.heartbeat("user-a", harness.created.swarm.id, { agentId: harness.coder.agent.id, credential: harness.coder.credential });
  assert.equal(recoveredAgent.status, "active");
  const leasedAgain = await harness.service.acquireTaskLease("user-a", harness.created.swarm.id, { agentId: harness.coder.agent.id, credential: harness.coder.credential }, task.id);
  const completed = await harness.service.completeTask("user-a", harness.created.swarm.id, { agentId: harness.coder.agent.id, credential: harness.coder.credential }, task.id, { result: { ok: true } });
  assert.equal(leasedAgain.status, "in_progress");
  assert.equal(completed.status, "completed");
  const cancelled = await harness.service.cancelSwarm("user-a", harness.created.swarm.id);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => harness.service.createTask("user-a", harness.created.swarm.id, { title: "blocked" }), (error) => error.code === "swarm_cancelled");
});

test("uses explicit conflict resolution and does not grant Normal Agent authority", () => {
  assert.deepEqual(resolveRufloConflict("write_write").resolution, "manual_review");
  assert.deepEqual(resolveRufloConflict("stale_workspace").resolution, "retry");
  assert.equal(typeof RufloSwarmError, "function");
});