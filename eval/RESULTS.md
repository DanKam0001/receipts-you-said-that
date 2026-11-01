# Evaluation results

## Status: NOT RUN FOR THE NLI REVISION

The 20 fresh held-out claims below were written and frozen before running the revised retrieval plus NLI verifier. No model inference or threshold tuning has run against this set. The previous held-out claims remain in eval/claims.json as seen_held_out because their outcomes have already been inspected; they are excluded from threshold selection and are not blind.

## Previous matcher run (historical; not blind)

- GPU faster-whisper small.en; mean chunk RTF 0.203; WER 11.53%.
- Previous single-score matcher: 3/30 correct, zero false RECEIPT FOUND, 27 CAN'T TELL. This is baseline context only and does not measure the new verifier.

## Fresh held-out claims (headline, n=20; not yet run)

Target: zero false RECEIPT FOUND and at least 14/20 correct. The completed run will include the actual outcome, entailment score, and deciding candidate for every claim.

| ID | Claim | Expected | Actual | Entailment score | Candidate |
|---|---|---|---|---:|---|
| fresh-01 | you said Alice noticed maps and pictures hanging on pegs along the sides as she fell | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-02 | you said she imagined asking whether the country was New Zealand or Australia | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-03 | you said Alice had shrunk to ten inches tall after tasting the drink | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-04 | you said she got nervous she might shrink away completely like a blown out candle | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-05 | you said she tried climbing a leg of the glass table but it was too slippery | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-06 | you said she found a tiny currant cake inside a little glass box under the table | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-07 | you said Alice ate the cake expecting it might change her size, but nothing happened | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-08 | you said the drink tasted like a mix of cherry tart, custard, pineapple, turkey, toffee and toast | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-09 | you said Alice once tried to box her own ears for cheating while playing croquet against herself | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-10 | you said she usually gave herself good advice but hardly ever followed it | RECEIPT FOUND | Not run | N/A | N/A |
| fresh-11 | you said the maps and pictures were painted on the ceiling above Alice | NO MATCH | Not run | N/A | N/A |
| fresh-12 | you said she wondered if the country was France or Italy | NO MATCH | Not run | N/A | N/A |
| fresh-13 | you said drinking the bottle made Alice grow to twenty inches tall | NO MATCH | Not run | N/A | N/A |
| fresh-14 | you said Alice was eager to shrink until she disappeared like a candle | NO MATCH | Not run | N/A | N/A |
| fresh-15 | you said the table leg was rough and easy for Alice to climb | NO MATCH | Not run | N/A | N/A |
| fresh-16 | you said the glass box with the cake was sitting on top of the table | NO MATCH | Not run | N/A | N/A |
| fresh-17 | you said the cake was labelled DRINK ME and covered in raisins | NO MATCH | Not run | N/A | N/A |
| fresh-18 | you said the cake immediately made Alice grow much taller | NO MATCH | Not run | N/A | N/A |
| fresh-19 | you said Alice was playing croquet against her sister when she cheated | NO MATCH | Not run | N/A | N/A |
| fresh-20 | you said Alice always followed every piece of advice she gave herself | NO MATCH | Not run | N/A | N/A |
