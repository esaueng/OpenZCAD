use glib::prelude::*;

#[test]
fn string_array_iterators_preserve_contents_and_bounds() {
    let values = ["", "alpha", "λ", "a long string", "終"];
    let variant = values.to_variant();
    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        values
    );
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        values.into_iter().rev().collect::<Vec<_>>()
    );
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("終"));
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), Some("終"));
    assert_eq!(iter.nth(1), Some("λ"));
    assert_eq!(iter.nth_back(0), Some("a long string"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    assert_eq!(variant.array_iter_str().unwrap().nth(99), None);
    assert_eq!(variant.array_iter_str().unwrap().nth_back(99), None);
    let empty = Vec::<String>::new().to_variant();
    assert_eq!(empty.array_iter_str().unwrap().next(), None);
    assert!(42_i32.to_variant().array_iter_str().is_err());
}
