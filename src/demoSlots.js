// Demo slots: weekday mornings for the next two weeks, 30-minute appointments,
// 9:00–11:00 Lagos time (UTC+1). Used to seed a new database and by `npm run seed`.

const PROVIDERS = ['Dr Ade Okafor', 'Dr Ngozi Eze', 'Dr Tunde Bakare'];
const LAGOS_START_HOURS = [9, 9.5, 10, 10.5]; // local start times

export function demoSlots(from = new Date(), days = 14) {
  const slots = [];
  for (let d = 1; d <= days; d++) {
    const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + d));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // clinic closed at weekends
    const date = day.toISOString().slice(0, 10);

    PROVIDERS.forEach((provider, p) => {
      LAGOS_START_HOURS.forEach((hour) => {
        const start = new Date(day.getTime() + (hour - 1) * 3_600_000); // Lagos = UTC+1
        const end = new Date(start.getTime() + 30 * 60_000);
        const hhmm = start.toISOString().slice(11, 16).replace(':', '');
        slots.push({
          id: `${date}-p${p + 1}-${hhmm}`,
          provider,
          start: start.toISOString().replace('.000Z', 'Z'),
          end: end.toISOString().replace('.000Z', 'Z'),
        });
      });
    });
  }
  return slots;
}
