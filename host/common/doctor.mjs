// host/common/doctor.mjs — the `doctor` checks harness.
//
// Exports:
//   makeDoctor() -> { add, checks, report, finish }
//     add(ok, label, advice)   records a check
//     checks                   the recorded [{ok, label, advice}]
//     report()                 prints " OK   <label>" / "FAIL  <label>" (+ "      -> <advice>" for
//                              failures); returns true unless a failed check had advice
//     finish()                 report() then process.exit(0 or 1)

export function makeDoctor() {
    const checks = [];
    const add = (ok, label, advice) => checks.push({ ok, label, advice });
    function report() {
        let allOk = true;
        for (const c of checks) {
            console.log(`${c.ok ? " OK " : "FAIL"}  ${c.label}`);
            if (!c.ok && c.advice) { console.log(`      -> ${c.advice}`); allOk = false; }
        }
        return allOk;
    }
    const finish = () => process.exit(report() ? 0 : 1);
    return { add, checks, report, finish };
}
