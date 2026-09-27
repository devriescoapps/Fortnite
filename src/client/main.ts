// SURGEFALL browser entry point.
import { Game } from './game';

const game = new Game();
(window as unknown as { game: Game }).game = game;
game.boot().catch((err) => {
  console.error(err);
  const msg = document.querySelector('.boot-msg');
  if (msg) msg.textContent = `Failed to start: ${(err as Error).message}`;
});
