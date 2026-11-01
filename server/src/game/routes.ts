import express, { type Router } from "express";
import { workspace } from "../workspace/bus.js";
import { busyFor, forgetGame, isGameOnScreen, presentGame } from "./present.js";
import { isFramed, realPlayers } from "./setup.js";
import { deleteGame, getActiveGameId, getGame, listGames, setActiveGame } from "./store.js";
import { toView } from "./view.js";

/**
 * Games API (mounted under /api):
 *   GET    /games              → [{id, title, genre, phase, players, playerNames, personaId, round, createdAt, updatedAt, active, onScreen}]
 *                                (optional ?personaId= filter; `players` is the number of heroes)
 *   GET    /games/:id          → GameView
 *   POST   /games/:id/open     → {ok}   — makes it its persona's active game and shows it in the workspace
 *   DELETE /games/:id          → {ok}   — clears the workspace if that game was on screen
 */
export function gamesRouter(): Router {
  const r = express.Router();

  r.get("/games", (req, res) => {
    const personaId = typeof req.query.personaId === "string" && req.query.personaId ? req.query.personaId : undefined;
    const active = new Map<string, string | null>();
    const activeFor = (pid: string) => {
      if (!active.has(pid)) active.set(pid, getActiveGameId(pid));
      return active.get(pid) ?? null;
    };
    res.json(
      listGames(personaId).map((g) => {
        const heroes = realPlayers(g);
        return {
          id: g.id,
          title: isFramed(g) ? g.title : "New Adventure",
          genre: g.genre,
          phase: g.phase,
          players: heroes.length,
          playerNames: heroes.map((p) => p.name),
          personaId: g.personaId,
          round: g.round,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          active: activeFor(g.personaId) === g.id,
          onScreen: isGameOnScreen(g.id),
        };
      }),
    );
  });

  r.get("/games/:id", (req, res) => {
    const g = getGame(req.params.id);
    if (!g) return res.status(404).json({ error: "game not found" });
    res.json(toView(g, busyFor(g.id)));
  });

  r.post("/games/:id/open", (req, res) => {
    const g = getGame(req.params.id);
    if (!g) return res.status(404).json({ error: "game not found" });
    setActiveGame(g.personaId, g.id);
    presentGame(g.id);
    res.json({ ok: true });
  });

  r.delete("/games/:id", (req, res) => {
    const id = req.params.id;
    const onScreen = isGameOnScreen(id);
    if (!deleteGame(id)) return res.status(404).json({ error: "game not found" });
    forgetGame(id);
    if (onScreen) workspace.clear();
    res.json({ ok: true });
  });

  return r;
}
