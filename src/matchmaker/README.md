# Matchmaker

This is a reference implementation of a matchmaker, which is responsible for incentivizing solvers to offer better prices for their intent solutions. To be elligible for the benefits the matchmaker offers, a user or app should restrict the filler of their intents to the matchmaker's address. Using the built-in authorization mechanism of Memswap, the matchmaker will then only authorize for filling the solver(s) which offer(s) the best price to the user. The reference implementation uses the signature authorization mechanism as follows:

- instead of submitting the solutions on-chain (as it's done for open or private intents), solvers of matchmaker-restricted intents can submit solutions directly to the matchmaker (which has a public API)
- for every intent that is being filled, the matchmaker will run a "blind" auction, with solvers submitting solutions without knowing what others submitted (thus being incentivized to bid high and offer users better prices)
- after the auction is complete, the matchmaker will submit the best-priced solution (worth noting that the solutions are signed transactions from the solver that anyone can relay on-chain)
