import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.protobuf.ByteString;
import com.spotify.playlist4.proto.Playlist4ApiProto;
import com.spotifyxp.spotapi.SpotAPI;
import com.spotifyxp.spotapi.TokenProvider;
import com.spotifyxp.spotapi.pojos.UserInfo;
import com.spotifyxp.spotapi.requests.playlist.ListChanges;
import okhttp3.*;
import okio.Buffer;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Wire-level smoke tests. An application interceptor answers EVERY request;
 * chain.proceed() is never called, so no Spotify connection is possible. */
public final class NtifyOfflineSmoke {
    private static final String ID = "37i9dQZF1DXcBWIGoYBM5M";
    private static final String TRACK = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
    private static final List<Map<String, Object>> results = new ArrayList<>();

    private static final class Wire implements Interceptor {
        final List<Request> requests = new ArrayList<>();
        final List<byte[]> bodies = new ArrayList<>();
        final Deque<Integer> codes = new ArrayDeque<>();

        @Override public Response intercept(Chain chain) throws IOException {
            Request request = chain.request();
            requests.add(request);
            Buffer buffer = new Buffer();
            if (request.body() != null) request.body().writeTo(buffer);
            bodies.add(buffer.readByteArray());
            int code = codes.isEmpty() ? 200 : codes.removeFirst();
            byte[] body;
            String contentType;
            if (request.url().encodedPath().contains("pathfinder")) {
                body = "{\"data\":{\"searchV2\":{}}}".getBytes(StandardCharsets.UTF_8);
                contentType = "application/json";
            } else {
                body = Playlist4ApiProto.SelectedListContent.newBuilder()
                    .setRevision(ByteString.copyFromUtf8("revision-" + requests.size()))
                    .setLength(0).buildPartial().toByteArray();
                contentType = "application/x-protobuf";
            }
            return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                .code(code).message("offline fixture")
                .body(ResponseBody.create(MediaType.get(contentType), body)).build();
        }

        SpotAPI api(TokenProvider provider) {
            SpotAPI.Builder builder = new SpotAPI.Builder()
                .setToken("offline-access-token").setClientToken("offline-client-token")
                .setAppPlatform("Linux").setUserAgent("euterpe-headless-lab/offline")
                .setSpotifyClientHost("never-connect.invalid")
                .setUserInfo(new UserInfo("offline-user", "BR", "PREMIUM"))
                .setHttpClient(new OkHttpClient.Builder().addInterceptor(this).build());
            if (provider != null) builder.setTokenProvider(provider);
            return builder.build();
        }

        Playlist4ApiProto.ListChanges mutation(int index) throws IOException {
            return Playlist4ApiProto.ListChanges.parseFrom(bodies.get(index));
        }
    }

    private interface Scenario { void run() throws Exception; }

    private static void check(boolean condition, String reason) {
        if (!condition) throw new AssertionError(reason);
    }

    private static void scenario(String name, String status, Scenario test) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", name);
        try {
            test.run();
            result.put("status", status);
        } catch (Throwable error) {
            result.put("status", "failed");
            result.put("error", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        results.add(result);
    }

    public static void main(String[] args) {
        scenario("rootlist_decode_and_pagination", "passed", () -> {
            Wire wire = new Wire();
            SpotAPI api = wire.api(null);
            Playlist4ApiProto.SelectedListContent list = api.playlist().rootlist()
                .setFrom(2).setLength(25).setDecorateAttributes(true).execute();
            check(list.getRevision().toStringUtf8().equals("revision-1"), "protobuf response not decoded");
            Request request = wire.requests.get(0);
            check(request.url().encodedPath().equals("/playlist/v2/user/offline-user/rootlist"), "rootlist endpoint");
            check("25".equals(request.url().queryParameter("length")), "pagination limit");
            check("2".equals(request.url().queryParameter("from")), "pagination offset");
            check("offline-client-token".equals(request.header("client-token")), "client token header");
        });

        scenario("create_playlist_protobuf_and_revision_cache", "passed", () -> {
            Wire wire = new Wire();
            SpotAPI api = wire.api(null);
            api.playlist().create().setId(ID).setName("Lab playlist").setDescription("offline only").execute();
            check(wire.requests.size() == 1, "creation should make one request before explicit follow");
            check("POST".equals(wire.requests.get(0).method()), "create method");
            check(wire.requests.get(0).url().encodedPath().equals("/playlist/v2/playlist/" + ID + "/changes"), "create endpoint");
            Playlist4ApiProto.Op operation = wire.mutation(0).getDeltas(0).getOps(0);
            check(operation.getKind() == Playlist4ApiProto.Op.Kind.UPDATE_LIST_ATTRIBUTES, "create operation");
            check(operation.getUpdateListAttributes().getNewAttributes().getValues().getName().equals("Lab playlist"), "name serialization");
            check(api.getCache().get(ListChanges.revisionKey(ID)).toStringUtf8().equals("revision-1"), "new revision not cached");
        });

        scenario("add_remove_reorder_and_base_revision", "passed", () -> {
            Wire wire = new Wire();
            SpotAPI api = wire.api(null);
            api.getCache().put(ListChanges.revisionKey(ID), ByteString.copyFromUtf8("base"));
            api.playlist().modifyPlaylistContent().setPlaylistId(ID).setItemInsertionIndex(7)
                .addPlayables(TRACK).removePlayables(TRACK)
                .addMoveOperations(Playlist4ApiProto.Mov.newBuilder().setFromIndex(0).setLength(1).setToIndex(2).build())
                .execute();
            Playlist4ApiProto.ListChanges body = wire.mutation(0);
            check(body.getBaseRevision().toStringUtf8().equals("base"), "base revision");
            List<Playlist4ApiProto.Op> ops = body.getDeltas(0).getOpsList();
            check(ops.size() == 3, "three content operations");
            check(ops.get(0).getAdd().getFromIndex() == 7, "insertion position");
            check(ops.get(0).getAdd().getItems(0).getUri().equals(TRACK), "track URI");
            check(ops.get(1).getRem().getItemsAsKey(), "remove-by-item semantics");
            check(ops.get(2).getMov().getToIndex() == 2, "move destination");
        });

        scenario("revision_cache_miss_fetches_before_write", "passed", () -> {
            Wire wire = new Wire();
            SpotAPI api = wire.api(null);
            api.playlist().modifyPlaylistContent().setPlaylistId(ID).addPlayables(TRACK).execute();
            check(wire.requests.size() == 2, "revision GET plus mutation POST expected");
            check(wire.requests.get(0).method().equals("GET"), "revision must be read first");
            check(wire.mutation(1).getBaseRevision().toStringUtf8().equals("revision-1"), "fetched revision not used");
        });

        scenario("rename_and_description", "passed", () -> {
            Wire wire = new Wire();
            SpotAPI api = wire.api(null);
            api.getCache().put(ListChanges.revisionKey(ID), ByteString.copyFromUtf8("base"));
            api.playlist().modifyPlaylist().setPlaylistId(ID).setName("New name").setDescription("New description").execute();
            check(wire.mutation(0).getDeltas(0).getOpsCount() == 2, "two attribute changes");
        });

        scenario("pathfinder_search_wire_format", "passed", () -> {
            Wire wire = new Wire();
            wire.api(null).feed().search().setSearchTerm("Miles Davis").setLimit(5).execute();
            JsonObject body = JsonParser.parseString(new String(wire.bodies.get(0), StandardCharsets.UTF_8)).getAsJsonObject();
            check(wire.requests.get(0).url().encodedPath().equals("/pathfinder/v2/query"), "Pathfinder endpoint");
            check(body.get("operationName").getAsString().equals("searchDesktop"), "persisted operation");
            check(body.getAsJsonObject("variables").get("searchTerm").getAsString().equals("Miles Davis"), "search text");
            check(body.getAsJsonObject("extensions").getAsJsonObject("persistedQuery").get("sha256Hash").getAsString().length() == 64, "persisted query hash");
        });

        scenario("unauthorized_refresh_retries_once", "passed", () -> {
            Wire wire = new Wire();
            wire.codes.add(401); wire.codes.add(200);
            int[] refreshes = {0};
            SpotAPI api = wire.api(() -> { refreshes[0]++; return "fresh-offline-token"; });
            api.playlist().rootlist().execute();
            check(refreshes[0] == 1 && wire.requests.size() == 2, "refresh count");
            check(wire.requests.get(1).headers("authorization").size() == 1, "duplicate authorization header");
            check("Bearer fresh-offline-token".equals(wire.requests.get(1).header("authorization")), "refreshed authorization");
        });

        scenario("unauthorized_second_failure_stops", "passed", () -> {
            Wire wire = new Wire();
            wire.codes.add(401); wire.codes.add(401);
            SpotAPI api = wire.api(() -> "fresh-offline-token");
            try { api.playlist().rootlist().execute(); throw new AssertionError("401 accepted"); }
            catch (IOException expected) { check(wire.requests.size() == 2, "unbounded auth retry"); }
        });

        scenario("gateway_timeout_does_not_repeat_mutation", "passed", () -> {
            Wire wire = new Wire();
            wire.codes.add(504);
            SpotAPI api = wire.api(null);
            api.getCache().put(ListChanges.revisionKey(ID), ByteString.copyFromUtf8("base"));
            try { api.playlist().modifyPlaylistContent().setPlaylistId(ID).addPlayables(TRACK).execute(); throw new AssertionError("504 accepted"); }
            catch (IOException expected) { check(wire.requests.size() == 1, "mutation was repeated"); }
        });

        scenario("cover_only_change_rejected_by_upstream_validation", "gap_confirmed", () -> {
            Wire wire = new Wire();
            try {
                wire.api(null).playlist().modifyPlaylist().setPlaylistId(ID).setImageBytes(new byte[]{1, 2, 3}).execute();
                throw new AssertionError("Known cover-only gap no longer reproduced; review candidate");
            } catch (IllegalArgumentException expected) {
                check(wire.requests.isEmpty(), "cover-only error should be local validation");
                check(expected.getMessage().contains("No modifications"), "unexpected validation failure");
            }
        });

        scenario("visibility_only_change_rejected_by_upstream_validation", "gap_confirmed", () -> {
            Wire wire = new Wire();
            try {
                wire.api(null).playlist().modifyPlaylist().setPlaylistId(ID).setPublic(false).execute();
                throw new AssertionError("Known visibility-only gap no longer reproduced; review candidate");
            } catch (IllegalArgumentException expected) {
                check(wire.requests.isEmpty(), "visibility-only error should be local validation");
            }
        });

        Map<String, Object> report = new LinkedHashMap<>();
        report.put("mode", "offline_interceptor_no_network");
        report.put("candidate", "ntify-spotapi");
        report.put("live_spotify_validated", false);
        report.put("cases", results);
        System.out.println(new Gson().toJson(report));
        if (results.stream().anyMatch(result -> result.get("status").equals("failed"))) System.exit(1);
    }
}
