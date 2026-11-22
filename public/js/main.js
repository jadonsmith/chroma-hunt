// Entry point: ?tv opens the big-screen view, everything else is a phone.
import { startPhone } from "./phone.js";
import { startTv } from "./tv.js";

const params = new URLSearchParams(location.search);
if (params.has("tv")) startTv();
else startPhone();
