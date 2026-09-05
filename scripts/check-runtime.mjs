const expectedNode = "v24.20.0";
const expectedNpm = "11.19.0";
const npmUserAgent = process.env.npm_config_user_agent ?? "";

if (process.version !== expectedNode) {
  throw new Error(
    `Expected Node.js ${expectedNode}, received ${process.version}.`,
  );
}

const npmMatch = /^npm\/(\d+\.\d+\.\d+) node\/(v\d+\.\d+\.\d+)\b/.exec(
  npmUserAgent,
);
if (!npmMatch) {
  throw new Error(
    "npm_config_user_agent is missing the npm and Node.js versions.",
  );
}
if (npmMatch[1] !== expectedNpm || npmMatch[2] !== expectedNode) {
  throw new Error(
    `Expected npm ${expectedNpm} on Node.js ${expectedNode}, received ${npmMatch[1]} on ${npmMatch[2]}.`,
  );
}

console.log(`Runtime verified: Node.js ${expectedNode}, npm ${expectedNpm}.`);
