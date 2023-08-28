# Solver

This is a reference implementation of a solver, which is responsible for providing solutions to intents. The way it works is by listening to any pending mempool transactions and trying to extract any intents shared this way. Any profitable intents are then attempted to be solved via various configurable [solutions](./solutions) (the current implementation supports solving via 0x and via UniswapV3 but any other solutions can be plugged-in). Implementation-wise, the solver is composed of two main asynchronous jobs:

- [`tx-listener`](./jobs/tx-listener.ts): responsible for discovering intents from mempool transactions
- [`ts-solver`](./jobs/tx-solver.ts): responsible for generating solutions for intents (open, private and [matchmaker](../matchmaker) intents are all supported)
