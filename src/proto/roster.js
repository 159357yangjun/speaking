import { assertFingerprint } from "../crypto/keys.js";

const HANDLE = /^[a-z0-9-]{1,32}$/;
const ROLES = ["initiator", "member"];

export function loadRoster(raw) {
  const roster = typeof raw === "string" ? JSON.parse(raw) : raw;
  const problems = [];

  for (const k of ["channel", "created_by", "goal", "max_members", "members"]) {
    if (!(k in roster)) problems.push(`缺字段 ${k}`);
  }
  if (problems.length) throw new Error(`roster 非法：${problems.join("；")}`);

  if (!HANDLE.test(roster.channel)) problems.push("channel 命名非法");
  if (!Number.isInteger(roster.max_members) || roster.max_members < 2 || roster.max_members > 8)
    problems.push("max_members 必须在 2–8");
  if (!Array.isArray(roster.members) || roster.members.length < 1)
    problems.push("members 至少一条");
  if (roster.members.length > roster.max_members) problems.push("成员数超过上限");

  const seen = new Set();
  let initiators = 0;
  for (const m of roster.members ?? []) {
    if (!HANDLE.test(m.handle ?? "")) problems.push(`handle 非法：${m.handle}`);
    if (seen.has(m.handle)) problems.push(`handle 重复：${m.handle}`);
    seen.add(m.handle);
    try {
      assertFingerprint(m.fingerprint ?? "");
    } catch (e) {
      problems.push(`${m.handle}: ${e.message}`);
    }
    if (!ROLES.includes(m.role)) problems.push(`${m.handle}: role 非法`);
    if (m.role === "initiator") initiators += 1;
  }
  if (initiators !== 1) problems.push(`initiator 必须恰好一个，实际 ${initiators}`);
  if (!seen.has(roster.created_by)) problems.push("created_by 不在 members 里");

  if (problems.length) throw new Error(`roster 非法：${[...new Set(problems)].join("；")}`);
  return roster;
}

export function keyringOf(roster) {
  return Object.fromEntries(roster.members.map((m) => [m.handle, m.fingerprint]));
}

export function isClosed(roster) {
  return roster.closed === true || roster.members.length >= roster.max_members;
}
