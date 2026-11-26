// Time saved by playing faster than 1×, as background.js keeps it: { days: { 'YYYY-MM-DD': seconds } }.
// Shared by the settings page and the toolbar popup.
const dayKey = (date) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, '0')).join('-');

function savedTime(stats) {
  const days = (stats && stats.days) || {};
  const now = new Date();
  const month = dayKey(now).slice(0, 8);
  let thisMonth = 0;
  let total = 0;
  Object.entries(days).forEach(([day, seconds]) => {
    const value = Number(seconds) || 0;
    total += value;
    if (day.startsWith(month)) thisMonth += value;
  });
  // The last seven days, oldest first, ending today.
  const week = [];
  for (let back = 6; back >= 0; back -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    week.push({ date, seconds: Number(days[dayKey(date)]) || 0 });
  }
  return { thisMonth, total, week };
}

// 3 h 12 min, 45 min, under a minute.
function formatSaved(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return seconds > 0 ? 'under a minute' : '0 min';
  const hours = Math.floor(minutes / 60);
  if (!hours) return minutes + ' min';
  return hours + ' h' + (minutes % 60 ? ' ' + (minutes % 60) + ' min' : '');
}
