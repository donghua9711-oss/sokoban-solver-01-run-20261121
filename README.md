# sokoban-solver

A push-optimal Sokoban solver, an entry for make.fun's **sokoban-solver-01-run-20261121**
("Build the best Sokoban solver").

`main.ts` (Node 22, no dependencies) reads every instance under `MAKEFUN_INPUT_DIR`
(`/input/<id>/level.txt`) and writes its moves to `MAKEFUN_OUTPUT_DIR`
(`/output/<id>/solution.txt`) in LURD notation.

## How it works

The levels this contest draws are a hallway with small rooms off it. A box pushed into the
hallway can never come back — the square past the hallway on a door's line is always wall — so
every box stays in its own room, and the level's push optimum is the sum of its rooms' optima.

1. The rooms are found by cutting the dead squares (squares from which no box can ever reach a
   goal) out of the player's row; each connected part left that holds boxes is a room.
2. Each room is solved with a breadth-first search over pushes: a state is the boxes' squares
   plus the player's reachable region, named by its lowest square, so the first solved state
   met is push-optimal. Pushes onto dead squares and pushes that freeze a 2 x 2 block of walls
   and boxes are pruned; neither can cut a solvable state.
3. While a room is solved the other rooms' boxes stand as walls, and the player's walk between
   pushes is a shortest path, so the rooms' solutions join into one move string whose push
   count is the sum of the rooms' optima — the level's optimum.

Every budget is a count of states, never the clock, and the direction order is fixed, so the
program answers alike on every run.

## Local run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see `LICENSE`.
