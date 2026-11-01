// Next worker processes must inherit a single --require entry point.
require("./deny-network-egress.cjs");
require("../../scripts/_stubs/server-only-stub.cjs");
