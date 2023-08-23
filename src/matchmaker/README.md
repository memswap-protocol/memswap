# Matchmaker

This is a reference implementation of a matchmaker, which is responsible for incentivizing solvers to offer better prices for their intent solutions. To be elligible for the benefits the matchmaker offers, a user or app should restrict the filler of their intents to the matchmaker's address. Using the built-in authorization mechanism of Memswap, the matchmaker will then only authorize for filling the solver(s) which offer(s) the best price to the user. The reference implementation uses the signature authorization mechanism as follows:

- instead of submitting the solutions on-chain (as it's done for open or private intents), solvers of matchmaker-restricted intents can submit solutions directly to the matchmaker (which has a public API)
- for every intent that is being filled, the matchmaker will run a 2-step auction: the first part of the auction will be won by the best-priced solution and in turn sets the starting price of the second step of the auction where any submission that offers at least the price of the previous step's winning solution is considered "successful"
- the matchmaker will only release authorization signatures in the second part of the auction for "successful" solutions
- since multiple signatures can be released by the matchmaker for any single intent, the solvers should do their best to have their solutions included in a block as soon as possible
- to protect against "griefing" (eg. a solver providing a best-priced solution only to eliminate competition, but then not going through with the solution), the matchmaker requires all solvers to submit a signed transaction to the matchmaker (which in theory the matchmaker could always submit on-chain, thus forcing the solver to go through with their solution) (this is not bulletproof but it disincentivizes this behaviour)