import { expect, test } from "bun:test";
import { CommandBus } from "../../../src/commands/command-bus.js";

test("CommandBus registers, executes, and unregisters typed commands", async () => {
  const bus = new CommandBus();
  const unregister = bus.register<{ left: number; right: number }, number>(
    "sum",
    ({ payload }) => payload.left + payload.right,
  );
  expect(
    await bus.execute<{ left: number; right: number }, number>("sum", { left: 2, right: 3 }),
  ).toBe(5);
  unregister();
  await expect(bus.execute("sum", {})).rejects.toMatchObject({
    code: "COMMAND_UNKNOWN",
  });
});
