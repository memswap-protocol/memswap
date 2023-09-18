# Solver

This is a reference implementation of a solver, which is responsible for providing solutions to intents. The way it works is by listening to any pending mempool transactions and trying to extract any intents shared this way. Any profitable intents are then attempted to be solved via various configurable [solutions](./solutions) (the current implementation supports solving ERC20 intents via 0x and UniswapV3, and ERC721 intents via Reservoir, but any other solutions can be plugged-in). Implementation-wise, the solver is composed of two main asynchronous jobs:

- [`tx-listener`](./jobs/tx-listener.ts): responsible for discovering intents from mempool transactions
- [`ts-solver-erc20`](./jobs/tx-solver-erc20.ts): responsible for generating solutions for ERC20 intents (open, private and [matchmaker](../matchmaker) intents are all supported)
- [`ts-solver-erc721`](./jobs/tx-solver-erc721.ts): responsible for generating solutions for ERC721 intents (open, private and [matchmaker](../matchmaker) intents are all supported)
- [`inventory-manager`](./jobs/inventory-manager.ts): responsible for managing the inventory of the solver (eg. liquidating any tokens obtained as profits from solving intents)
