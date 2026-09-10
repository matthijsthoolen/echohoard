const TOTAL_MESSAGES = 150_000;
const PAGE_SIZE = 50;
const RETAINED_WINDOW = 300;
const retained = new Map();
let peak = 0;

for (let offset = 0; offset < TOTAL_MESSAGES; offset += PAGE_SIZE) {
  const end = Math.min(TOTAL_MESSAGES, offset + PAGE_SIZE);
  for (let index = offset; index < end; index += 1) {
    retained.set(`synthetic-${index}`, { id: `synthetic-${index}`, sentAt: index });
    while (retained.size > RETAINED_WINDOW) retained.delete(retained.keys().next().value);
  }
  peak = Math.max(peak, retained.size);
}

if (retained.size > RETAINED_WINDOW || peak > RETAINED_WINDOW)
  throw new Error(`retained window exceeded ${RETAINED_WINDOW}`);

console.log(
  JSON.stringify(
    {
      messagesProfiled: TOTAL_MESSAGES,
      pageSize: PAGE_SIZE,
      retainedWindow: RETAINED_WINDOW,
      peakRetainedMessages: peak,
      result: "bounded",
    },
    null,
    2,
  ),
);
