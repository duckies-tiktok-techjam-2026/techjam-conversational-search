# Shopping Copilot

Shopping Copilot turns a short shopping conversation into a focused product shortlist. It asks one helpful follow-up question at a time, remembers the shopper's answers, and updates its recommendations as new details arrive. It can also adapt when a shopper changes their mind or has no preference for a requested detail.

Our main idea is to search using the shopper's exact wording, rather than relying only on a simplified summary of their request. A broad request such as “a men's T-shirt” can match thousands of products. However, a detail like “jersey knit,” “tagless,” or “4.3 oz” can be much more distinctive. These small phrases often appear directly in a product's listed features or details, making them strong clues for finding the right item.

After each reply, Shopping Copilot keeps the useful phrases alongside structured preferences such as material, colour, budget, and product type. It searches the catalog for products that match several clues together, instead of promoting an item just because it matches one popular keyword. It then reranks the most promising products using everything the shopper has said so far. When preferences conflict, the latest preference takes priority and the replaced one is treated as a signal to avoid.

This approach keeps the conversation simple for the shopper while making search progressively more precise. The default system runs fully offline, without API calls, model training, or a GPU.

On the public evaluation set of 200 conversations, the rule-based version placed the intended product in its top 10 recommendations 96.5% of the time, with the first successful recommendation appearing by turn 3 on average.

## Development tools

- Python 3.10+
- Cursor / VS Code
- Python virtual environment (`venv`) for the optional model-based reranker

## APIs used

None. The default submission is self-contained and runs offline.

## Libraries and frameworks

The default system uses only the Python standard library, including SQLite's full-text search support for catalog search.

We also included an optional second ranking stage:

- `sentence-transformers`
- `cross-encoder/ms-marco-MiniLM-L-6-v2`
- PyTorch, installed as a dependency of `sentence-transformers`

This optional stage can improve ranking when installed, but the submission automatically falls back to the offline rule-based system if it is unavailable.

## Datasets and assets

- The challenge's frozen 50,000-product catalog
- The challenge's public evaluation set of 200 simulated shopping conversations
- Both are derived from the Amazon Reviews 2023 dataset released by McAuley Lab at UC San Diego

We did not collect or manually label additional data, and we did not train a model on the competition data.
