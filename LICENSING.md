# Agentor licensing and provenance

Agentor contains code under more than one license. This document describes the
repository's mixed provenance; it does not revoke or narrow any previously
granted rights.

## Upstream work: MIT

This repository derives from `lonetis/agentor`. The inherited upstream history
through commit `c3e83e2f184b78abe0badd8f4ff735442caa1443` remains available under
the MIT License in [LICENSE](LICENSE), including its original copyright notice:

> Copyright (c) 2026 Louis Jannett

Previously published MIT versions and all upstream-originated portions retain
their MIT grants. Upstream notices must not be removed.

## Downstream Agentor-specific work: intended ELv2 grant

Agentor-specific additions after the upstream baseline are intended to be
offered by their applicable rights holder(s) under the standard Elastic License
2.0 in [LICENSE-ELASTIC-2.0](LICENSE-ELASTIC-2.0). ELv2 permits personal,
academic, modification, and internal company use under its terms. It restricts
providing the ELv2-covered software itself to third parties as a hosted or
managed service where users receive a substantial set of its functionality;
that use may require separate permission from the applicable downstream
licensor.

The Git history identifies multiple downstream authors, but it does not prove
copyright assignment or establish a single entity authorized to license every
downstream contribution. The downstream licensor identity therefore remains to
be confirmed. This repository does not invent one or imply that Git authorship
alone proves ownership. Until the applicable rights holder confirms the grant,
the ELv2 direction above should be read as an intended licensing declaration,
not an unsupported assertion made on another contributor's behalf.

## Mixed files and third-party software

Many downstream changes modify files inherited under MIT. Those mixed files
continue to contain MIT-licensed upstream material; downstream changes are
covered only to the extent the applicable contributor has authority to offer
them under ELv2. A single SPDX header is deliberately not applied to mixed
files because it would misstate their provenance.

Dependencies installed from package registries, operating-system packages,
browser distributions, agent CLIs, and other third-party components retain
their own licenses. Agentor does not relicense them. No vendored or submodule
source tree requiring an additional root notice was found in the August 2026
provenance audit; future copied or vendored code must retain its notices and be
recorded here or in an appropriate third-party notice file.
