package com.workwell.engine.port;

/**
 * Port: evaluation-time configuration. Currently the per-measure target compliance rate used by the
 * synthetic distribution; real adapters need not honor it.
 */
public interface EvaluationConfigProvider {

    double complianceRate(String rateKey);
}
