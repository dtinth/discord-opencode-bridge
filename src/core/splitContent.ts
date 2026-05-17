export function splitContent(content: string, maxLength = 2000): string[] {
  if (content.length === 0) return [""];
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const chunks: string[] = [];
  let currentChunk = "";
  let currentLength = 0;
  for (const { segment } of segmenter.segment(content)) {
    const segLen = Array.from(segment).length;
    if (currentLength + segLen > maxLength && currentChunk !== "") {
      chunks.push(currentChunk);
      currentChunk = segment;
      currentLength = segLen;
    } else {
      currentChunk += segment;
      currentLength += segLen;
    }
  }
  if (currentChunk !== "") chunks.push(currentChunk);
  return chunks;
}
