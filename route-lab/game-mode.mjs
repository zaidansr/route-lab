import { createGameManager } from './game-manager.mjs';
import { createDashboard } from './dashboard.mjs';

export async function startGameMode({ dashboardPort = 8766, ...managerOptions } = {}) {
  const manager = await createGameManager(managerOptions);
  try { await manager.refresh(); } catch { /* Dashboard retains the explicit unchecked status. */ }
  const web = await createDashboard({ port: dashboardPort, pageFile: './game.html', getStatus: manager.snapshot, command: manager.command });
  let refreshing = false;
  const timer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true; try { await manager.refresh(); } catch {} finally { refreshing = false; }
  }, 15000); timer.unref();
  return { url: web.url, manager, async close() { clearInterval(timer); await web.close(); } };
}
