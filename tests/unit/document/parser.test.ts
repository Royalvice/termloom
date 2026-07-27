import { expect, test } from "bun:test";
import { parseRichDocument } from "../../../src/document/parser.js";

test("parses GFM, math, images, video, and sanitized limited HTML", async () => {
  const document = await parseRichDocument(`
# Remote README

- one
- two

| Name | Value |
| --- | ---: |
| answer | 42 |

\`\`\`ts
const answer = 42
\`\`\`

[safe link](https://example.com) [unsafe](javascript:alert(1))

![relative](./images/picture.png "Picture")
<img src="/assets/animation.gif" alt="animation" onerror="steal()">

Inline $x^2 + y^2$.

$$
\\int_0^1 x^2 dx
$$

<video controls muted poster="../poster.webp">
  <source src="./clip.mp4" type="video/mp4">
</video>
<script>globalThis.compromised = true</script>
`);

  expect(document.math).toEqual([
    expect.objectContaining({ source: "x^2 + y^2", display: false }),
    expect.objectContaining({ source: "\\int_0^1 x^2 dx", display: true }),
  ]);
  expect(document.media).toEqual([
    expect.objectContaining({
      kind: "image",
      sources: [{ uri: "./images/picture.png" }],
      alt: "relative",
      title: "Picture",
    }),
    expect.objectContaining({
      kind: "image",
      sources: [{ uri: "/assets/animation.gif" }],
      alt: "animation",
    }),
    expect.objectContaining({
      kind: "video",
      sources: [{ uri: "./clip.mp4", mimeType: "video/mp4" }],
      posterUri: "../poster.webp",
      controls: true,
      muted: true,
    }),
  ]);

  const safe = JSON.stringify(document.safeTree);
  expect(safe).toContain('"tagName":"table"');
  expect(safe).toContain('"tagName":"code"');
  expect(safe).toContain('"tagName":"video"');
  expect(safe).not.toContain("script");
  expect(safe).not.toContain("onerror");
  expect(safe).not.toContain("javascript:");
});
