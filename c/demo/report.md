# Mandate audit report

Generated 2026-11-23T10:01:09.000Z · last 24 hours · 43 high, 40 medium, 0 info

# Daily Audit Note: 22–23 November 2026

**Yes, today's record needs attention.** Over about four minutes on 22 November, one account took full control of every part of the system, appointed new office-holders and a council, handed control to a different account, and then gave up its own powers.

### High-severity alerts

**One account gave itself top-level control everywhere.** Between 11:31 and 11:32 on 22 November, account 0xC782…f834 granted itself the ADMIN role on ten parts of the system:
- identity registry
- mandate registry
- charter (voting rules)
- voting
- civic budget
- decision markets
- officials registry
- smaller voter lists
- government bodies
- citizens' assemblies
- paper and in-person results

In every case the account approved its own grant. This matters because ADMIN is the highest permission level, and the record shows no second party approving it.

**Charter authority granted.** 0xC782…f834 gave the GOVERNOR role on the charter (voting rules) to 0x316B…6467. This matters because the charter sets the rules for how votes work.

**Voting connected to smaller voter lists.** The voting system was linked to a voter-list contract at 0xB1eF…6530. Polls can now be limited to the groups that contract defines.

**Three new identity sources approved.** These sources can confirm residents' identities:
- "Demo front desk 2" (0x433B…476F), approved up to the verified tier
- "Demo front desk 3" (0x4C9a…b71B), approved up to the verified tier
- "Online sign-up" (0x7b12…2889), approved up to the basic tier

Sources like these decide who gets verified, so each approval matters. Two of the approved names begin with "Demo."

**A council was formed.** Three accounts joined the council: 0x433B…476F, 0xb8e5…Cb71 and 0x0C5F…5777. Changes now need 2 approvals and a 24-hour waiting period. These settings add checks on future changes.

**Control was handed over.** At about 11:34, 0xC782…f834 granted ADMIN on all ten parts of the system to 0xb847…C3C4. Between 11:34 and 11:35 it then removed its own ADMIN role from all ten. The alerts do not say whether 0xb847…C3C4 is connected to the council.

### Other activity

0xC782…f834 also granted a number of working roles to other accounts:
- **Proposing votes:** five accounts received the PROPOSER role on voting.
- **Mandate registry:** two accounts received the GOVERNOR role.
- **Decision markets:** 0x316B…6467 received the VETO role.
- **Unnamed roles:** several roles that appear in the record only as codes were granted on the officials registry, government bodies, paper and in-person results, and smaller voter lists.

One account, 0x433B…476F, now holds an unusually wide set of roles. It is:
- an approved identity source
- a council member
- a proposer on voting and the civic budget
- a carrier on voting
- an organiser of citizens' assemblies
- a holder of coded roles on four other parts of the system

0xC782…f834 removed all of its remaining working roles from itself on 22 November. On 23 November at 09:45 it removed several of the same roles again. This included an ORGANIZER role on "People's Agenda," a role whose original grant does not appear in these alerts.

## All alerts

- **high** ADMIN role granted to 0xC782…f834 on identity registry ([tx](https://sepolia.basescan.org/tx/0x62c3c9dc318c502175a3bfbc7b1d152586addeecf4275d7f3ce24ed9b32224d2))
- **high** ADMIN role granted to 0xC782…f834 on mandate registry ([tx](https://sepolia.basescan.org/tx/0xd4644d634bea166221f486c2f521d058fbddaa7bfe72c1621d8f0cc808fa9b58))
- **high** ADMIN role granted to 0xC782…f834 on charter (voting rules) ([tx](https://sepolia.basescan.org/tx/0x0da6f9a01cfac07fb9d20d49e8b7f1d33f2ef8cd7f0fa19a45730250223fed13))
- **high** ADMIN role granted to 0xC782…f834 on voting ([tx](https://sepolia.basescan.org/tx/0x0d01dc0524040778ee92bf900d941255f8b0e0efd662eabb54049499883d6c99))
- **high** ADMIN role granted to 0xC782…f834 on civic budget ([tx](https://sepolia.basescan.org/tx/0x162db82f7c2f46f4ad7e91f3f2c3212d6b07cce527658d7a68a5e565c2cfdf03))
- **high** ADMIN role granted to 0xC782…f834 on decision markets ([tx](https://sepolia.basescan.org/tx/0xd19da09722e832e5204b57885d82b26c77eaeb39c61324cd6dbcc25e7273fd08))
- **medium** GOVERNOR role granted to 0x316B…6467 on mandate registry ([tx](https://sepolia.basescan.org/tx/0xe1d7faa5cffacd91652dd197cf6f7c9f67eda0a086b75ff4b651d493046a41ff))
- **medium** GOVERNOR role granted to 0xE616…5aCE on mandate registry ([tx](https://sepolia.basescan.org/tx/0xfc366065d21a2ee58069e9ddbfefbfd3b94d2f5c3c8949e7d4b9cac76c996392))
- **medium** VETO role granted to 0x316B…6467 on decision markets ([tx](https://sepolia.basescan.org/tx/0xee516ea66bebca98b9ec2301ed4380315ff4eefc141f27e8eff609eb3700a695))
- **medium** PROPOSER role granted to 0xC782…f834 on voting ([tx](https://sepolia.basescan.org/tx/0x199bfb44e4fe79b75d59295ae5a1030d7ca3456518ccca516e234bade02d8652))
- **medium** PROPOSER role granted to 0xC782…f834 on civic budget ([tx](https://sepolia.basescan.org/tx/0x3d17d714a626d9e96c76ab1fca7434a2ba18db83d5ff8a5b510784c3f442f905))
- **high** GOVERNOR role granted to 0x316B…6467 on charter (voting rules) ([tx](https://sepolia.basescan.org/tx/0xd5c5b116cff5b5b1ebfc7ba2bd31afdd8a41cb1fef9e06d73a4d2eedeca91495))
- **high** ADMIN role granted to 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0xfeeae573e66c1f17e5284bd1d06ab3a72425d4924ef8ff8e6a526803c20574ed))
- **high** ADMIN role granted to 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x09f9b75755fb96610c3a525019a8fa1857955549e4a56c7e918920242f7fb033))
- **medium** 0xc26be8e0016d7720ca689986256cecb8764bcfd041a3c876681d44dc4d9d7519 role granted to 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x51e93e455a96338d51b96a276b5c0fe79873f5ec6ce7e34ca02cca59cbb44f89))
- **high** Voting contract connected to smaller voter lists at 0xB1eF…6530: polls can now be limited to its groups ([tx](https://sepolia.basescan.org/tx/0xed693bd96255e90ea1f8a9de11b2b6375672369c565653e5558aaed008485d26))
- **medium** PROPOSER role granted to 0x3BD2…9428 on voting ([tx](https://sepolia.basescan.org/tx/0x0042a7982073178bfa58c8a364d08ffb9c632a46932bb1f0217c6029e7c4189a))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role granted to 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0xf0d7e83c0c425ec1096ff9cab2dd173709251cb03d76912f071e55fdd4616444))
- **high** ADMIN role granted to 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0x5c2da83ef34bc50f5104d282804ba26952ec6d7f1011f9e0712a5356b3fad796))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role granted to 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0x5c2da83ef34bc50f5104d282804ba26952ec6d7f1011f9e0712a5356b3fad796))
- **medium** PROPOSER role granted to 0x9272…e7eD on voting ([tx](https://sepolia.basescan.org/tx/0xb6540e6e5ab6bf0d12368436a757b81d86626013599d1993f57c9d15cf2b4463))
- **medium** PROPOSER role granted to 0xcd6f…aCfF on voting ([tx](https://sepolia.basescan.org/tx/0x2b29e77972221e6996b87bc651b32aaf3cbbf0e8d3a7f4a6120340341242d17b))
- **high** ADMIN role granted to 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0x45a37a8be6981b4dc417b98cf8296c9b3421962ea713760ba071c0b9ea3693fa))
- **medium** ORGANIZER role granted to 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0x7c662b57d042b076fa7bf036440a003254dc7af92993b4212103df2ee2e4a0d5))
- **high** ADMIN role granted to 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0x6d529f050ca0969058bc8f5bfa15178bf18637ce87ec3ae3dfd8ec1a0758b45f))
- **medium** 0xd603cc2d39ea2ab57038652f29ac8e7fd0e40e6a9b0f81de9bbc4acc6780d962 role granted to 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0x6d529f050ca0969058bc8f5bfa15178bf18637ce87ec3ae3dfd8ec1a0758b45f))
- **medium** ISSUER role granted to 0x433B…476F on identity registry ([tx](https://sepolia.basescan.org/tx/0x8292f37a55338e0eb18069d897794dfc871f39118667c3b7d51907e290b9b99b))
- **high** Identity source "Demo front desk 2" (0x433B…476F) approved, up to verified tier ([tx](https://sepolia.basescan.org/tx/0x8292f37a55338e0eb18069d897794dfc871f39118667c3b7d51907e290b9b99b))
- **medium** ISSUER role granted to 0x4C9a…b71B on identity registry ([tx](https://sepolia.basescan.org/tx/0x261e0a5f94e160b3d0e251dc2debec8f9b11056ebc4eb9728d29060e1f14a700))
- **high** Identity source "Demo front desk 3" (0x4C9a…b71B) approved, up to verified tier ([tx](https://sepolia.basescan.org/tx/0x261e0a5f94e160b3d0e251dc2debec8f9b11056ebc4eb9728d29060e1f14a700))
- **medium** ISSUER role granted to 0x7b12…2889 on identity registry ([tx](https://sepolia.basescan.org/tx/0xd7cde287ddd94b86e68b087bc986fa7014550e8d840b5d595685ce25655e354a))
- **high** Identity source "Online sign-up" (0x7b12…2889) approved, up to basic tier ([tx](https://sepolia.basescan.org/tx/0xd7cde287ddd94b86e68b087bc986fa7014550e8d840b5d595685ce25655e354a))
- **medium** PROPOSER role granted to 0x433B…476F on voting ([tx](https://sepolia.basescan.org/tx/0x43588737d5f576f28d0a3848711f785c9c3bdc8e2d3ef575c245fcf9a4a3d093))
- **medium** PROPOSER role granted to 0x433B…476F on civic budget ([tx](https://sepolia.basescan.org/tx/0xb6bcea22cf184516b862b251298f0dcfa53dedcde1651635f213959f89ce03d5))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role granted to 0x433B…476F on officials registry ([tx](https://sepolia.basescan.org/tx/0xc76a11a4990aa4cfda7518e237d036ccb1449e3f27e20d787b921400c55e5d7b))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role granted to 0x433B…476F on government bodies ([tx](https://sepolia.basescan.org/tx/0xf11de497608995f9c1002f36d27d30d102fa0c2863f5e6a21a3f0cb84b8ff7d5))
- **medium** 0xd603cc2d39ea2ab57038652f29ac8e7fd0e40e6a9b0f81de9bbc4acc6780d962 role granted to 0x433B…476F on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0xff13dd21cac718ab9d8467182f75c6994307bdd9dea56a360fe7d5b2dc9ddcb4))
- **medium** 0xd603cc2d39ea2ab57038652f29ac8e7fd0e40e6a9b0f81de9bbc4acc6780d962 role granted to 0x4C9a…b71B on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0xc906df3bd3740078b33c09f9c61944e3cc386e5a63f5c6700f6810708a2e1d0f))
- **medium** 0xc26be8e0016d7720ca689986256cecb8764bcfd041a3c876681d44dc4d9d7519 role granted to 0x433B…476F on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x0b541095a72ea9137448e32aec180dbe5b8544be36a7a774279b476373a46949))
- **medium** CARRIER role granted to 0x433B…476F on voting ([tx](https://sepolia.basescan.org/tx/0xb824c45d9a2b5ae0e275c6984567c8029d8f820eda72404fea5d86c7a899758f))
- **medium** CARRIER role granted to 0x4C9a…b71B on voting ([tx](https://sepolia.basescan.org/tx/0x4bfb9a4d758c04404e930271cc03e0224424be40f086d49145c35fbe86315e1f))
- **medium** ORGANIZER role granted to 0x433B…476F on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0x9c43c3faadfe8cbc249177833691892aaa6617b744b0a4af113261018eba992f))
- **high** 0x433B…476F joined the council ([tx](https://sepolia.basescan.org/tx/0xbb23d1ab72ff5d9d96f23c49baa47b66aaa380c345fef3b55b69983cec222582))
- **high** 0xb8e5…Cb71 joined the council ([tx](https://sepolia.basescan.org/tx/0xbb23d1ab72ff5d9d96f23c49baa47b66aaa380c345fef3b55b69983cec222582))
- **high** 0x0C5F…5777 joined the council ([tx](https://sepolia.basescan.org/tx/0xbb23d1ab72ff5d9d96f23c49baa47b66aaa380c345fef3b55b69983cec222582))
- **high** The council now needs 2 approvals per change ([tx](https://sepolia.basescan.org/tx/0xbb23d1ab72ff5d9d96f23c49baa47b66aaa380c345fef3b55b69983cec222582))
- **high** The council waiting period is now 24 hours ([tx](https://sepolia.basescan.org/tx/0xbb23d1ab72ff5d9d96f23c49baa47b66aaa380c345fef3b55b69983cec222582))
- **medium** PROPOSER role granted to 0xb847…C3C4 on voting ([tx](https://sepolia.basescan.org/tx/0xffcc62b79e51f35957ed72083675529b6cbe9cbcfef9ecad57df460ccb61dac6))
- **high** ADMIN role granted to 0xb847…C3C4 on identity registry ([tx](https://sepolia.basescan.org/tx/0xd4929f9e7dc01c7d701dd6c4804e4dc2c7ef20d9bd436d3f54d286d3f30d26eb))
- **high** ADMIN role granted to 0xb847…C3C4 on mandate registry ([tx](https://sepolia.basescan.org/tx/0x35f2bd6793d30926d0a259cd49651e60bf6dfa9092bcc1dcf42f7a6f651c1072))
- **high** ADMIN role granted to 0xb847…C3C4 on voting ([tx](https://sepolia.basescan.org/tx/0xf8be727b511e430f93a369187092792e3a40d30be810b4a061e711928d08cbc9))
- **high** ADMIN role granted to 0xb847…C3C4 on decision markets ([tx](https://sepolia.basescan.org/tx/0x3e9c83c380b7fd3f6dfc416d5e9e979ccf64c114040947f9f40355df6bf1b6e3))
- **high** ADMIN role granted to 0xb847…C3C4 on charter (voting rules) ([tx](https://sepolia.basescan.org/tx/0xd96bd8c69b8f37a64e630fed32c97e7927ceb58c68212d2fc720a39116f1db6e))
- **high** ADMIN role granted to 0xb847…C3C4 on civic budget ([tx](https://sepolia.basescan.org/tx/0x35cc0948759fc58e52e3f9ed64e2725a64902ca44b03bdf6075edb40bc23cf6d))
- **high** ADMIN role granted to 0xb847…C3C4 on officials registry ([tx](https://sepolia.basescan.org/tx/0xd03674b65a38af899c5858e37d7533c2aa506034954906cfb6bfc571322eda98))
- **high** ADMIN role granted to 0xb847…C3C4 on government bodies ([tx](https://sepolia.basescan.org/tx/0x5bd677cc264c913c2268c1c41cfc6d6e5465fcb78216c316be5727aaaffa86fe))
- **high** ADMIN role granted to 0xb847…C3C4 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0x55fcf7e4e07766ce73306df8d65c38f98ea5749ac0226cc03d0abd3e843664b9))
- **high** ADMIN role granted to 0xb847…C3C4 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0xf83beeac9561fc02d96f340d9aa6a9485b25cb20357bf90501aafa4fcfe95082))
- **high** ADMIN role granted to 0xb847…C3C4 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0x5033dabf8a2cc632a9b477a4a1bc24d7c4c9647b750820ce98db31935e2071b8))
- **high** ADMIN role revoked from 0xC782…f834 on identity registry ([tx](https://sepolia.basescan.org/tx/0x17d907fd46473f33f48e5db6669b4d76286bd9932746a471fa7fe332b4907fd7))
- **high** ADMIN role revoked from 0xC782…f834 on mandate registry ([tx](https://sepolia.basescan.org/tx/0x6fb0943b61981bee48a3ae8d76a997b1a722313bad08afb71f318b2ca9cf4d87))
- **high** ADMIN role revoked from 0xC782…f834 on voting ([tx](https://sepolia.basescan.org/tx/0xf8fa77d2437608b54e6abcafcf2f49fe691466eb25d36c0a78fd6eeab557d244))
- **high** ADMIN role revoked from 0xC782…f834 on decision markets ([tx](https://sepolia.basescan.org/tx/0xcc595e774261b637abb03bfc9c2276eb118d1c26a5088111a2374dd83e01c94a))
- **high** ADMIN role revoked from 0xC782…f834 on charter (voting rules) ([tx](https://sepolia.basescan.org/tx/0x67664d2d967d371ce612a086faf8890577ce183bc097cba071429770037f82e1))
- **high** ADMIN role revoked from 0xC782…f834 on civic budget ([tx](https://sepolia.basescan.org/tx/0x10be983e3ac51e98c7000a82a3c387e898b771979a4b9d3293be9c9e7f969225))
- **high** ADMIN role revoked from 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0x7fdf11c5775f846196685700b5cd7cfffa8e7c56a13cab876e827d49e7dd1dd8))
- **high** ADMIN role revoked from 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0x70dbc640fde23404e513473340911b705a73bc708d10e16b41b85d82a408a30b))
- **high** ADMIN role revoked from 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0xc54839212718e041f836338d518ce5ba50e723f12134ba83a68805b1cd621558))
- **high** ADMIN role revoked from 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x9f39a21001cb0203d98c63ffb2ab8fcb7cfcce87bcef23bca300ebccab8746d9))
- **high** ADMIN role revoked from 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0xb2b3f14fb598d4135be2af163aa10c782e2352f11d8e30cadd2a1beb1d85c7ab))
- **medium** PROPOSER role revoked from 0xC782…f834 on voting ([tx](https://sepolia.basescan.org/tx/0x8b852b8be24828a48a20ea1e559c5312df75ef0598290864d45293800ba75efd))
- **medium** PROPOSER role revoked from 0xC782…f834 on civic budget ([tx](https://sepolia.basescan.org/tx/0x73b06dbcd80656988cc2469de8d2f878f4fa9de3c667427e971bddd0da7c77ae))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role revoked from 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0x68326a18f74dd2db2d91ccb948a783e4759ff35d8896b994f169a76ec37b9510))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role revoked from 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0xbd62ff73bddc64cf3dc875d4129f676b393c74c12f1d194a69e5229dff523572))
- **medium** 0xc26be8e0016d7720ca689986256cecb8764bcfd041a3c876681d44dc4d9d7519 role revoked from 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x824b7d97edb0f17dd16f5b2975bbc903071ec5fdc4d89395f46c0a1d0d66e8d5))
- **medium** 0xd603cc2d39ea2ab57038652f29ac8e7fd0e40e6a9b0f81de9bbc4acc6780d962 role revoked from 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0x246ffee9e5b9274c8f5353d06ce165eb9b209bfdcbcf6f2cf21e73fd5c2d80b9))
- **medium** ORGANIZER role revoked from 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0xff9ce9f0a33a83aabacf06c40be8217c669d41df2d13f210e56cf141084dfb07))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role revoked from 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0xa2efa621760ce4b824c997806e3f1eecb3ddd824e6ad990348c12c870a78aadc))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role revoked from 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0x16c240e88a5aa637b415b3df2462c0b80779d5215d89c5c4db109aa2a4a5f789))
- **medium** 0xc26be8e0016d7720ca689986256cecb8764bcfd041a3c876681d44dc4d9d7519 role revoked from 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x6f30a3886951403cd8f2ea527936b881e5ce0a7856b387ae1b9e75335f021175))
- **medium** 0xd603cc2d39ea2ab57038652f29ac8e7fd0e40e6a9b0f81de9bbc4acc6780d962 role revoked from 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0x4caef38348d9bae87f8566a3808dbcde4aed116e3978334c899079b0238486fe))
- **medium** ORGANIZER role revoked from 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0xf7333afd806edeb3402f685339ac3cbb8c250ec7f61d79ddcf0626d8d8a125a5))
- **medium** ORGANIZER role revoked from 0xC782…f834 on People's Agenda ([tx](https://sepolia.basescan.org/tx/0xf35e55a6f7c6281527c988def0f8cc97d44718dbe6bce13ac64d2f7259457280))

Summary written by: AI (claude-opus-5-5); the alerts themselves come from fixed rules.
