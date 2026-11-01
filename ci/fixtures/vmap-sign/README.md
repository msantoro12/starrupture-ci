`test-feed-k1.txt` is the loader's own test fixture (Tests/VersionFeedTests),
signed with the TEST-ONLY key whose public half is slot k1 of the loader's feed
reader. It proves the Node verifier accepts what the loader's fixture holds. It
carries no secret. The release key is slot k2; nothing here is signed with it.
