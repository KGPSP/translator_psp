export function createSessionId(createdAt: Date, existingNames: string[], entropy = crypto.randomUUID()) {
  const date = formatSessionDate(createdAt);
  const sessionNumber = nextSessionNumber(existingNames);
  const shortId = entropy.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();

  return {
    id: `${date}_sesja_${String(sessionNumber).padStart(4, "0")}_id_${shortId}`,
    sessionNumber
  };
}

export function nextSessionNumber(existingNames: string[]) {
  const highestNamedSession = existingNames.reduce((highest, name) => {
    const match = name.match(/(?:^|_)sesja_(\d+)(?:_|$)/);
    if (!match) return highest;
    return Math.max(highest, Number(match[1]));
  }, 0);

  return Math.max(highestNamedSession, existingNames.length) + 1;
}

function formatSessionDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}
