if (!process.env.SUPPORT_EVAL_APPROVED_BASELINE_HASH) {
  console.error(
    "EVAL BASELINE PENDING: run npm run eval:candidate-report and obtain human approval for its exact report hash before required evals can pass.",
  );
  process.exit(2);
}
