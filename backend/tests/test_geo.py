from app.services.geo import interpolate_line, looks_like_road


def test_interpolated_chord_is_not_a_road():
    coords = interpolate_line(43.6588, 51.1975, 43.3412, 52.8619, n=16)
    assert looks_like_road(coords) is False


def test_bent_polyline_looks_like_a_road():
    coords = interpolate_line(43.6588, 51.1975, 43.3412, 52.8619, n=16)
    mid = len(coords) // 2
    coords[mid] = [coords[mid][0] + 0.08, coords[mid][1] + 0.04]
    assert looks_like_road(coords) is True


def test_dense_polyline_is_treated_as_a_road():
    coords = [[51.0 + i * 0.01, 43.5] for i in range(40)]
    assert looks_like_road(coords) is True


def test_short_segment_is_not_a_road():
    assert looks_like_road([[51.2, 43.6], [51.3, 43.7]]) is False
